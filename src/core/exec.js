import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, ErrorCode } from './errors.js';

export const IS_WIN = process.platform === 'win32';

const whichCache = new Map();

/** Locate an executable on PATH (honours PATHEXT on Windows). Cached. */
export function which(name, env = process.env) {
  const key = name + '\0' + (env.PATH || env.Path || '');
  if (whichCache.has(key)) return whichCache.get(key);
  let found = null;
  if (path.isAbsolute(name)) {
    found = isExecutable(name) ? name : null;
  } else {
    const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = IS_WIN ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';')] : [''];
    outer: for (const d of dirs) {
      for (const ext of exts) {
        const p = path.join(d, name + ext);
        if (isExecutable(p)) {
          found = p;
          break outer;
        }
      }
    }
  }
  whichCache.set(key, found);
  return found;
}

export function clearWhichCache() {
  whichCache.clear();
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and its children. */
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, signal); // whole process group (spawned detached)
      } catch {
        child.kill(signal);
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Run a program to completion. Never rejects for a non-zero exit code — callers
 * inspect `code`. Rejects only when the program cannot be started.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: object, input?: string|Buffer, timeoutMs?: number,
 *          maxBytes?: number, encoding?: 'utf8'|'buffer', signal?: AbortSignal, shell?: boolean,
 *          windowsVerbatimArguments?: boolean}} [opts]
 */
export function run(cmd, args = [], opts = {}) {
  const {
    cwd,
    env,
    input,
    timeoutMs = 60000,
    maxBytes = 50 * 1024 * 1024,
    encoding = 'utf8',
    signal,
    shell = false,
    windowsVerbatimArguments,
  } = opts;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        shell,
        windowsHide: true,
        detached: !IS_WIN,
        windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(spawnError(cmd, err));
      return;
    }
    const out = [];
    const errBufs = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref();
    }, timeoutMs) : null;
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      if (outLen < maxBytes) out.push(d);
      outLen += d.length;
    });
    child.stderr.on('data', (d) => {
      if (errLen < maxBytes) errBufs.push(d);
      errLen += d.length;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(spawnError(cmd, err));
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      const stdoutBuf = Buffer.concat(out);
      const stderrBuf = Buffer.concat(errBufs);
      resolve({
        code: code ?? (timedOut || cancelled ? -1 : 0),
        signal: sig,
        stdout: encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8'),
        stderr: stderrBuf.toString('utf8'),
        timedOut,
        cancelled,
        truncated: outLen > maxBytes || errLen > maxBytes,
        durationMs: Date.now() - started,
        pid: child.pid,
      });
    });
    if (input !== undefined && input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function spawnError(cmd, err) {
  if (err && err.code === 'ENOENT') {
    return new ToolError(ErrorCode.DEPENDENCY_MISSING, `Executable not found: ${cmd}`, { cause: err });
  }
  return new ToolError(ErrorCode.BACKEND_FAILED, `Failed to start ${cmd}: ${err?.message ?? err}`, { cause: err });
}

/** Run and throw a BACKEND_FAILED ToolError on non-zero exit. Returns stdout. */
export async function runOk(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.timedOut) throw new ToolError(ErrorCode.TIMEOUT, `${path.basename(cmd)} timed out after ${opts.timeoutMs ?? 60000}ms`);
  if (r.code !== 0) {
    const msg = (r.stderr || (typeof r.stdout === 'string' ? r.stdout : '') || '').trim().split('\n').slice(-5).join('\n');
    throw new ToolError(ErrorCode.BACKEND_FAILED, `${path.basename(cmd)} exited with code ${r.code}${msg ? `: ${msg}` : ''}`, {
      details: { command: [cmd, ...args.map((a) => (String(a).length > 200 ? String(a).slice(0, 200) + '…' : a))].join(' ') },
    });
  }
  return r.stdout;
}

/**
 * Start a long-lived detached process (GUI apps, servers). The child is not tied
 * to our lifetime, so apps keep running after the MCP server exits.
 */
export function spawnDetached(cmd, args = [], { cwd, env, logFile } = {}) {
  let fd = 'ignore';
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, 'a');
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: false,
      });
    } catch (err) {
      reject(spawnError(cmd, err));
      return;
    }
    let done = false;
    child.once('error', (err) => {
      if (done) return;
      done = true;
      reject(spawnError(cmd, err));
    });
    // 'spawn' fires once the OS has started the process.
    child.once('spawn', () => {
      if (done) return;
      done = true;
      child.unref();
      if (typeof fd === 'number') fs.closeSync(fd);
      resolve({ pid: child.pid, child });
    });
  });
}

/**
 * Feed `input` to a program that may fork a long-lived child holding its
 * stdio open (xclip, wl-copy). Waits for the *parent* to exit, not for pipes to close.
 */
export function runWithInputDetached(cmd, args, input, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(spawnError(cmd, err));
      return;
    }
    const timer = setTimeout(() => resolve({ code: 0, detached: true }), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(spawnError(cmd, err));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve({ code: code ?? 0 });
      else reject(new ToolError(ErrorCode.BACKEND_FAILED, `${path.basename(cmd)} exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
