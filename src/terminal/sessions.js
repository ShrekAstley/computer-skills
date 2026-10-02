import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { resolveShell, sessionInvocation, completionMarker, commandPrefix, MARKER_RE } from './shells.js';
import { killTree, which, IS_WIN } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { shortId, truncateMiddle } from '../core/util.js';
import { stripAnsi } from './run.js';
import { expandPath } from '../core/paths.js';

const MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Long-lived interactive terminal sessions. State (cwd, env vars, activated
 * virtualenvs, REPL state) persists between `send` calls. Output accumulates
 * in a ring buffer; each read returns what is new since the previous read.
 *
 * For shells, `send` can wait for the command to finish (a completion marker
 * reports its exit status). For REPLs and prompts (python, ssh, installers),
 * wait for a regex (`wait_for`) or for output to go idle.
 */
export class SessionManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  get(id) {
    const s = this.sessions.get(id) ?? [...this.sessions.values()].find((x) => x.name === id);
    if (!s) throw new ToolError(ErrorCode.NOT_FOUND, `No terminal session "${id}"`, { hint: 'List sessions with terminal_session action "list", or start one.' });
    return s;
  }

  start({ shell, cwd, env, name, command, pty = false } = {}) {
    if (this.sessions.size >= 16) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Too many open sessions (16). Close some first.');
    const s = new Session({ shell, cwd, env, name, command, pty, config: this.config, logger: this.logger });
    this.sessions.set(s.id, s);
    s.onExit = () => {
      // keep exited sessions around briefly so their final output can be read
      setTimeout(() => this.sessions.get(s.id) === s && s.exited && this.sessions.delete(s.id), 10 * 60 * 1000).unref();
    };
    return s;
  }

  close(id, { force = false } = {}) {
    const s = this.get(id);
    s.close(force);
    this.sessions.delete(s.id);
    return s.summary();
  }

  disposeAll() {
    for (const s of this.sessions.values()) s.close(true);
    this.sessions.clear();
  }
}

class Session {
  constructor({ shell, cwd, env, name, command, pty, config, logger }) {
    this.id = shortId('term-');
    this.name = name || this.id;
    this.config = config;
    this.logger = logger;
    this.cwd = cwd ? path.resolve(expandPath(cwd)) : process.cwd();
    if (!fs.existsSync(this.cwd)) throw new ToolError(ErrorCode.NOT_FOUND, `Working directory does not exist: ${this.cwd}`);
    this.buffer = '';
    this.dropped = 0; // chars dropped from the front of the ring buffer
    this.cursor = 0; // absolute position of the last read
    this.exited = false;
    this.exitCode = null;
    this.startedAt = new Date().toISOString();
    this.waiters = new Set();

    let cmd, args;
    if (command) {
      // A program rather than a shell (python REPL, ssh, node, …)
      this.shell = { name: 'program', kind: 'program', path: command };
      cmd = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
      args = IS_WIN ? ['/d', '/s', '/c', command] : ['-c', `exec ${command}`];
    } else {
      this.shell = resolveShell(shell, config);
      ({ cmd, args } = sessionInvocation(this.shell));
    }
    this.pty = false;
    if (pty && !IS_WIN && which('script')) {
      // Wrap in `script` to allocate a pseudo-terminal: programs then behave as if a human typed.
      const inner = [cmd, ...args].map(shq).join(' ');
      if (process.platform === 'darwin') {
        args = ['-q', '/dev/null', cmd, ...args];
      } else {
        args = ['-qfec', inner, '/dev/null'];
      }
      cmd = which('script');
      this.pty = true;
    }
    this.child = spawn(cmd, args, {
      cwd: this.cwd,
      env: { ...process.env, ...(env || {}), TERM: this.pty ? 'xterm-256color' : 'dumb', NO_COLOR: this.pty ? undefined : '1', PAGER: 'cat', GIT_PAGER: 'cat', PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !IS_WIN,
      windowsHide: true,
    });
    this.pid = this.child.pid;
    const onData = (d) => this._append(d.toString('utf8'));
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.stdin.on('error', () => {});
    this.child.on('error', (err) => {
      this._append(`\n[session error: ${err.message}]\n`);
      this._markExit(-1);
    });
    this.child.on('exit', (code, sig) => this._markExit(code ?? (sig ? 128 : -1)));
  }

  _markExit(code) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this._notify();
    this.onExit?.();
  }

  _append(text) {
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER) {
      const cut = this.buffer.length - MAX_BUFFER;
      this.buffer = this.buffer.slice(cut);
      this.dropped += cut;
    }
    this._notify();
  }

  _notify() {
    for (const w of this.waiters) w();
  }

  get end() {
    return this.dropped + this.buffer.length;
  }

  textFrom(pos) {
    const rel = Math.max(0, pos - this.dropped);
    return this.buffer.slice(rel);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      shell: this.shell.name,
      pid: this.pid,
      cwd: this.cwd,
      pty: this.pty,
      running: !this.exited,
      exit_code: this.exitCode,
      started_at: this.startedAt,
      unread_chars: this.end - this.cursor,
    };
  }

  write(text) {
    if (this.exited) throw new ToolError(ErrorCode.APP_NOT_RUNNING, `Session ${this.name} has exited (code ${this.exitCode})`, { hint: 'Start a new session.' });
    this.child.stdin.write(text);
  }

  /**
   * Wait until `predicate(newText)` is true, the process exits, output is idle
   * for `idleMs`, or `timeoutMs` passes.
   */
  waitFor({ from, predicate, timeoutMs, idleMs, signal }) {
    return new Promise((resolve) => {
      let lastLen = this.end;
      let idleTimer = null;
      const finish = (reason) => {
        clearTimeout(timer);
        clearTimeout(idleTimer);
        this.waiters.delete(check);
        resolve(reason);
      };
      const armIdle = () => {
        if (!idleMs) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish('idle'), idleMs);
      };
      const check = () => {
        const text = this.textFrom(from);
        if (predicate && predicate(text)) return finish('matched');
        if (this.exited) return finish('exited');
        if (this.end !== lastLen) {
          lastLen = this.end;
          armIdle();
        }
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      signal?.addEventListener?.('abort', () => finish('cancelled'), { once: true });
      this.waiters.add(check);
      armIdle();
      check();
    });
  }

  /**
   * Send input. Modes:
   *  - complete=true (shell sessions): wait for the command to finish; returns exit_code.
   *  - waitFor regex: wait until the output matches.
   *  - otherwise wait until output is idle for idleMs.
   */
  async send({ input, newline = true, complete, waitFor, timeoutMs = 30000, idleMs = 800, signal, maxChars }) {
    const isShell = this.shell.kind !== 'program';
    const useMarker = complete ?? (isShell && !waitFor);
    const from = this.end;
    let token = null;
    let payload = input ?? '';
    if (newline && !payload.endsWith('\n')) payload += this.shell.kind === 'cmd' ? '\r\n' : '\n';
    if (useMarker && isShell) {
      payload = commandPrefix(this.shell) + payload;
      token = shortId('').slice(0, 8);
      payload += completionMarker(this.shell, token) + (this.shell.kind === 'cmd' ? '\r\n' : '\n');
    }
    this.write(payload);
    let re = null;
    if (waitFor) {
      try {
        re = new RegExp(waitFor, 'm');
      } catch (err) {
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Invalid wait_for regex: ${err.message}`);
      }
    }
    const predicate = token
      ? (t) => new RegExp(`__CS_DONE_${token}_(-?\\d+)__`).test(t)
      : re
        ? (t) => re.test(stripAnsi(t))
        : null;
    const reason = await this.waitFor({ from, predicate, timeoutMs, idleMs: token || re ? 0 : idleMs, signal });
    return this._collect(from, { reason, token, maxChars, echoed: input });
  }

  async read({ waitFor, timeoutMs = 0, idleMs = 0, signal, maxChars, all = false } = {}) {
    const from = all ? this.dropped : this.cursor;
    let reason = 'immediate';
    if (waitFor || timeoutMs) {
      const re = waitFor ? new RegExp(waitFor, 'm') : null;
      reason = await this.waitFor({ from, predicate: re ? (t) => re.test(stripAnsi(t)) : null, timeoutMs: timeoutMs || 10000, idleMs, signal });
    }
    return this._collect(from, { reason, maxChars });
  }

  _collect(from, { reason, token, maxChars, echoed }) {
    let text = stripAnsi(this.textFrom(from));
    let exitCode;
    if (token) {
      const m = text.match(new RegExp(`\\n?__CS_DONE_${token}_(-?\\d+)__\\r?\\n?`));
      if (m) {
        exitCode = Number(m[1]);
        text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      }
      // Remove echoed marker command lines (PTY sessions echo input).
      text = text.split(/\r?\n/).filter((l) => !l.includes(`__CS_DONE_${token}_`)).join('\n');
    }
    // Drop markers belonging to other calls, and the echo of the input in PTY mode.
    text = text.replace(new RegExp(MARKER_RE.source + '\\r?\\n?', 'g'), '');
    if (this.pty && echoed) {
      const first = echoed.split('\n')[0];
      if (first && text.startsWith(first)) text = text.slice(first.length).replace(/^\r?\n/, '');
    }
    this.cursor = this.end;
    const out = truncateMiddle(text.replace(/\r\n/g, '\n'), maxChars ?? this.config?.terminal?.maxOutputChars ?? 30000);
    const res = { session: this.id, output: out.text, status: reason, running: !this.exited };
    if (exitCode !== undefined) res.exit_code = exitCode;
    if (this.exited) res.process_exit_code = this.exitCode;
    if (out.truncated) res.truncated = true;
    if (reason === 'timeout') res.hint = 'Timed out waiting. The command may still be running or waiting for input: read again later, send input, or signal SIGINT.';
    return res;
  }

  /**
   * Interrupt/terminate what is running. For shell sessions the signal goes to
   * the shell's children (the running command) — a non-interactive shell would
   * itself exit on SIGINT. PTY sessions get a real Ctrl+C.
   */
  signal(sig = 'SIGINT') {
    if (this.exited) return { delivered: false };
    if (this.pty && sig === 'SIGINT') {
      this.child.stdin.write('\x03');
      return { delivered: true, via: 'ctrl-c' };
    }
    if (IS_WIN) {
      if (sig === 'SIGINT') this.child.stdin.write('\x03');
      else killTree(this.child);
      return { delivered: true };
    }
    if (this.shell.kind === 'program') {
      try {
        process.kill(-this.child.pid, sig);
      } catch {
        this.child.kill(sig);
      }
      return { delivered: true };
    }
    const kids = childPids(this.child.pid);
    for (const pid of kids) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
    return { delivered: kids.length > 0, pids: kids };
  }

  close(force) {
    if (this.exited) return;
    try {
      if (!force) {
        this.child.stdin.end(this.shell.kind === 'program' ? '' : 'exit\n');
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => !this.exited && killTree(this.child, 'SIGKILL'), force ? 0 : 2000).unref();
    if (force) killTree(this.child, 'SIGKILL');
  }
}

function shq(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Direct child pids of a process (POSIX). */
function childPids(pid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    try {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
      return out.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === pid).map(([p]) => p);
    } catch {
      return [];
    }
  }
}
