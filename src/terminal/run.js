import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/exec.js';
import { resolveShell, oneShotInvocation } from './shells.js';
import { truncateMiddle, sleep } from '../core/util.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { expandPath } from '../core/paths.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r(?!\n)/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

/**
 * Categorise a failed command so the agent can decide whether to retry,
 * fix its invocation, or escalate. Returns null for success.
 */
export function analyzeFailure({ code, stdout = '', stderr = '', timedOut }) {
  if (timedOut) return { category: 'timeout', retryable: true, hint: 'The command exceeded its timeout. Increase timeout_ms, run it as a background process (process start), or check whether it is waiting for input.' };
  if (code === 0) return null;
  const text = `${stderr}\n${stdout}`.slice(-6000);
  const tests = [
    [/command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)|No such file or directory.*(?:bin|exec)|not found$/im, 'not-found', false, 'The program is not installed or not on PATH. Check with environment inspect (tools) or install it (requires approval).'],
    [/permission denied|access is denied|operation not permitted|EACCES|EPERM|UnauthorizedAccess/i, 'permission', false, 'Permission problem. Check file ownership/permissions; do not escalate privileges without the user\'s approval.'],
    [/could not resolve host|name or service not known|getaddrinfo|ENOTFOUND|temporary failure in name resolution|network is unreachable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (?:timed out|reset|refused)|TLS handshake|SSL_ERROR|502 Bad Gateway|503 Service Unavailable|429 Too Many Requests/i, 'network', true, 'Network failure. Retry with backoff; if it persists, check connectivity/proxy settings.'],
    [/no space left on device|ENOSPC|disk quota exceeded/i, 'disk-full', false, 'The disk is full. Free space before retrying.'],
    [/could not get lock|lock file exists|another process|resource temporarily unavailable|EBUSY|database is locked|index\.lock/i, 'locked', true, 'A resource is locked by another process. Wait and retry, or find the process holding it.'],
    [/syntax error|unexpected token|parse error|ParserError|unexpected EOF/i, 'syntax', false, 'The command has a syntax error for this shell. Check quoting and that you used the right shell (bash vs PowerShell vs cmd).'],
    [/out of memory|Killed$|ENOMEM|MemoryError/im, 'memory', false, 'The process ran out of memory.'],
    [/merge conflict|CONFLICT \(/i, 'conflict', false, 'Version control conflict needs resolution.'],
  ];
  for (const [re, category, retryable, hint] of tests) if (re.test(text)) return { category, retryable, hint };
  if (code === 127) return { category: 'not-found', retryable: false, hint: 'Exit 127: command not found.' };
  if (code === 126) return { category: 'permission', retryable: false, hint: 'Exit 126: the file is not executable.' };
  if (code === 130 || code === 143 || code === 137) return { category: 'killed', retryable: false, hint: `Exit ${code}: the process was interrupted or killed.` };
  return { category: 'error', retryable: false, hint: 'Inspect stderr to determine the cause.' };
}

/**
 * Execute one command to completion.
 * @param {object} p
 * @param {string} p.command
 * @param {string} [p.shell]
 * @param {string} [p.cwd]
 * @param {Record<string,string>} [p.env]
 * @param {number} [p.timeoutMs]
 * @param {string} [p.stdin]
 * @param {boolean} [p.login]
 * @param {number} [p.retries]
 * @param {'network'|'retryable'|'any'} [p.retryOn]
 */
export async function runCommand(p, { config, signal } = {}) {
  const shell = resolveShell(p.shell, config);
  const cwd = p.cwd ? path.resolve(expandPath(p.cwd)) : process.cwd();
  if (!fs.existsSync(cwd)) throw new ToolError(ErrorCode.NOT_FOUND, `Working directory does not exist: ${cwd}`);
  const timeoutMs = p.timeoutMs ?? config?.terminal?.defaultTimeoutMs ?? 120000;
  const maxChars = p.maxOutputChars ?? config?.terminal?.maxOutputChars ?? 30000;
  const inv = oneShotInvocation(shell, p.command, { login: p.login });
  const attempts = [];
  const maxAttempts = 1 + Math.max(0, Math.min(5, p.retries ?? 0));
  let r;
  let failure;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    r = await run(inv.cmd, inv.args, {
      cwd,
      env: { ...(p.env || {}), ...(shell.kind === 'posix' ? { TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' } : {}) },
      input: p.stdin,
      timeoutMs,
      signal,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    failure = analyzeFailure(r);
    attempts.push({ attempt, exit_code: r.code, duration_ms: r.durationMs, category: failure?.category });
    if (!failure || r.cancelled) break;
    const shouldRetry = p.retryOn === 'any' || (p.retryOn === 'network' ? failure.category === 'network' : failure.retryable);
    if (!shouldRetry || attempt === maxAttempts) break;
    await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)), signal);
  }
  const stdout = truncateMiddle(stripAnsi(r.stdout), maxChars);
  const stderr = truncateMiddle(stripAnsi(r.stderr), Math.floor(maxChars / 2));
  const res = {
    ok: r.code === 0 && !r.timedOut,
    exit_code: r.code,
    stdout: stdout.text,
    stderr: stderr.text,
    duration_ms: r.durationMs,
    shell: shell.name,
    cwd,
  };
  if (r.timedOut) res.timed_out = true;
  if (r.cancelled) res.cancelled = true;
  if (stdout.truncated || stderr.truncated || r.truncated) res.truncated = true;
  if (failure) res.failure = failure;
  if (attempts.length > 1) res.attempts = attempts;
  return res;
}
