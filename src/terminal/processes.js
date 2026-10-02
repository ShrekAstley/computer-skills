import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { resolveShell, oneShotInvocation } from './shells.js';
import { run, killTree, IS_WIN } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { shortId, sleep } from '../core/util.js';
import { stripAnsi } from './run.js';
import { expandPath } from '../core/paths.js';

/**
 * Managed background processes (dev servers, watchers, long builds) with log
 * capture and readiness detection, plus read access to the OS process table.
 */
export class ProcessManager {
  constructor({ config, paths, logger }) {
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this.procs = new Map();
  }

  async start({ command, shell, cwd, env, name, readyPattern, readyPort, readyTimeoutMs = 30000, signal }) {
    const sh = resolveShell(shell, this.config);
    const dir = cwd ? path.resolve(expandPath(cwd)) : process.cwd();
    if (!fs.existsSync(dir)) throw new ToolError(ErrorCode.NOT_FOUND, `Working directory does not exist: ${dir}`);
    const id = shortId('proc-');
    const logDir = path.join(this.paths.logs, 'processes');
    await fsp.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${id}.log`);
    const inv = oneShotInvocation(sh, command);
    const child = spawn(inv.cmd, inv.args, {
      cwd: dir,
      env: { ...process.env, ...(env || {}), NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WIN,
      windowsHide: true,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const rec = {
      id,
      name: name || command.split(/\s+/).slice(0, 3).join(' '),
      command,
      cwd: dir,
      shell: sh.name,
      pid: child.pid,
      child,
      logFile,
      tail: '',
      startedAt: new Date().toISOString(),
      exitCode: null,
      exited: false,
      listeners: new Set(),
    };
    const onData = (d) => {
      const s = d.toString('utf8');
      stream.write(s);
      rec.tail = (rec.tail + s).slice(-64 * 1024);
      for (const l of rec.listeners) l();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      onData(`\n[failed to start: ${err.message}]\n`);
      rec.exited = true;
      rec.exitCode = -1;
    });
    child.on('exit', (code, sig) => {
      rec.exited = true;
      rec.exitCode = code ?? (sig ? 128 : -1);
      rec.endedAt = new Date().toISOString();
      stream.end(`\n[exited with code ${rec.exitCode}]\n`);
      for (const l of rec.listeners) l();
    });
    this.procs.set(id, rec);

    let ready = null;
    if (readyPattern || readyPort) {
      ready = await this._waitReady(rec, { readyPattern, readyPort, timeoutMs: readyTimeoutMs, signal });
    } else {
      await this._settle(rec, signal);
    }
    const res = this.summary(rec, { tailLines: 20 });
    if (ready) res.ready = ready;
    if (rec.exited && rec.exitCode !== 0) {
      res.hint = 'The process exited immediately. Inspect the output above.';
    }
    return res;
  }

  /**
   * Catch immediate failures (bad command, port in use): wait until the process
   * exits, or shows signs of life (output), or a settle window passes. Shell
   * startup is slow on Windows (PowerShell can take seconds), hence the larger window.
   */
  async _settle(rec, signal, maxMs = IS_WIN ? 6000 : 1500) {
    const end = Date.now() + maxMs;
    let firstOutputAt = null;
    while (Date.now() < end && !rec.exited && !signal?.aborted) {
      if (rec.tail && firstOutputAt === null) firstOutputAt = Date.now();
      if (firstOutputAt !== null && Date.now() - firstOutputAt > 300) break;
      await sleep(50);
    }
  }

  async _waitReady(rec, { readyPattern, readyPort, timeoutMs, signal }) {
    const re = readyPattern ? new RegExp(readyPattern, 'mi') : null;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (signal?.aborted) return { ready: false, reason: 'cancelled' };
      if (re && re.test(stripAnsi(rec.tail))) return { ready: true, via: 'pattern' };
      if (readyPort && (await portOpen(readyPort))) return { ready: true, via: 'port' };
      if (rec.exited) return { ready: false, reason: `exited with code ${rec.exitCode}` };
      await new Promise((r) => {
        const t = setTimeout(r, 250);
        rec.listeners.add(r);
        setTimeout(() => {
          clearTimeout(t);
          rec.listeners.delete(r);
        }, 260);
      });
    }
    return { ready: false, reason: `not ready after ${timeoutMs}ms` };
  }

  get(id) {
    const rec = this.procs.get(id) ?? [...this.procs.values()].find((p) => p.name === id);
    if (!rec) throw new ToolError(ErrorCode.NOT_FOUND, `No managed process "${id}"`);
    return rec;
  }

  summary(rec, { tailLines = 0 } = {}) {
    const s = {
      id: rec.id,
      name: rec.name,
      pid: rec.pid,
      command: rec.command,
      cwd: rec.cwd,
      running: !rec.exited,
      exit_code: rec.exitCode,
      started_at: rec.startedAt,
      log_file: rec.logFile,
    };
    if (rec.endedAt) s.ended_at = rec.endedAt;
    if (tailLines) s.output_tail = stripAnsi(rec.tail).split('\n').slice(-tailLines).join('\n');
    return s;
  }

  list() {
    return [...this.procs.values()].map((r) => this.summary(r));
  }

  async logs(id, { tail = 100, grep } = {}) {
    const rec = this.get(id);
    let text;
    try {
      text = await fsp.readFile(rec.logFile, 'utf8');
    } catch {
      text = rec.tail;
    }
    let lines = stripAnsi(text).split('\n');
    if (grep) {
      const re = new RegExp(grep, 'i');
      lines = lines.filter((l) => re.test(l));
    }
    return { ...this.summary(rec), lines: lines.slice(-tail), total_lines: lines.length };
  }

  async stop(id, { force = false, timeoutMs = 5000 } = {}) {
    const rec = this.get(id);
    if (!rec.exited) {
      killTree(rec.child, force ? 'SIGKILL' : 'SIGTERM');
      const end = Date.now() + timeoutMs;
      while (!rec.exited && Date.now() < end) await sleep(100);
      if (!rec.exited) {
        killTree(rec.child, 'SIGKILL');
        await sleep(300);
      }
    }
    return this.summary(rec, { tailLines: 10 });
  }

  disposeAll() {
    for (const rec of this.procs.values()) if (!rec.exited) killTree(rec.child);
  }
}

/** Snapshot of OS processes. */
export async function listSystemProcesses({ filter, limit = 50 } = {}) {
  let procs = [];
  if (IS_WIN) {
    const r = await run('tasklist', ['/fo', 'csv', '/nh'], { timeoutMs: 15000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const cols = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (cols.length < 5) continue;
      procs.push({ pid: Number(cols[1]), name: cols[0], memory_kb: Number(cols[4].replace(/[^\d]/g, '')) || undefined });
    }
  } else {
    const r = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm=,args='], { timeoutMs: 15000 });
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      procs.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], memory_kb: +m[4], name: path.basename(m[5]), command: m[6].slice(0, 300) });
    }
  }
  if (filter) {
    const f = filter.toLowerCase();
    procs = procs.filter((p) => p.name.toLowerCase().includes(f) || (p.command || '').toLowerCase().includes(f) || String(p.pid) === filter);
  }
  procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || (b.memory_kb ?? 0) - (a.memory_kb ?? 0));
  return { total: procs.length, processes: procs.slice(0, limit) };
}

export function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function killPid(pid, { force = false } = {}) {
  if (IS_WIN) {
    const r = await run('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], { timeoutMs: 15000 });
    if (r.code !== 0 && !force) {
      // GUI-less processes ignore WM_CLOSE; escalate.
      const r2 = await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 15000 });
      if (r2.code !== 0) throw new ToolError(ErrorCode.BACKEND_FAILED, `taskkill failed: ${r2.stderr || r2.stdout}`);
    }
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') throw new ToolError(ErrorCode.NOT_FOUND, `No process with pid ${pid}`);
    if (err.code === 'EPERM') throw new ToolError(ErrorCode.PERMISSION_DENIED, `Not permitted to signal pid ${pid}`);
    throw err;
  }
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => {
      if (host === '127.0.0.1') {
        // also try IPv6 loopback (servers bound to ::1 only)
        const s6 = net.connect({ port, host: '::1' });
        s6.setTimeout(timeoutMs, () => { s6.destroy(); resolve(false); });
        s6.once('connect', () => { s6.destroy(); resolve(true); });
        s6.once('error', () => { s6.destroy(); resolve(false); });
      } else done(false);
    });
  });
}
