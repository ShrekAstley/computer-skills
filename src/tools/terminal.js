import { defineTool } from './registry.js';
import { runCommand } from '../terminal/run.js';
import { classifyCommand, classifyScript, isSystemProcess } from '../safety/classifier.js';
import { listSystemProcesses, killPid } from '../terminal/processes.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { assessment } from './common.js';

const SHELLS = ['auto', 'bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd'];

export const terminalRun = defineTool({
  name: 'terminal_run',
  title: 'Run a command',
  description:
    'Run one shell command to completion and return exit code, stdout and stderr (ANSI stripped, long output truncated in the middle). ' +
    'Picks the right shell for the OS ("auto": your $SHELL/bash on Linux/macOS, pwsh/powershell on Windows) or use `shell`. ' +
    'Failures include a `failure` object {category: not-found|permission|network|locked|syntax|timeout|..., retryable, hint}. ' +
    'Use `retries` for flaky network operations. For long-running servers/watchers use `process` (action start); for stateful/interactive work use `terminal_session`. ' +
    'Commands are risk-classified: destructive or system-changing commands may require the user\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      shell: { type: 'string', enum: SHELLS, description: 'Shell to use (default auto).' },
      cwd: { type: 'string', description: 'Working directory (default: the project directory).' },
      env: { type: 'object', description: 'Extra environment variables.', additionalProperties: { type: 'string' } },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 3600000, description: 'Kill the command after this long (default 120000).' },
      stdin: { type: 'string', description: 'Text piped to the command\'s standard input.' },
      login: { type: 'boolean', description: 'Run as a login shell (loads profile files; slower).' },
      retries: { type: 'integer', minimum: 0, maximum: 5, description: 'Retry failed runs (with backoff) when the failure is retryable.' },
      retry_on: { type: 'string', enum: ['retryable', 'network', 'any'], description: 'Which failures to retry (default retryable).' },
    },
    required: ['command'],
  },
  openWorld: true,
  assess: (a, rt) => classifyCommand(a.command, rt.policy.classifierOptions({ cwd: a.cwd || rt.paths.project.root })),
  summary: (a) => `run \`${a.command}\`${a.cwd ? ` in ${a.cwd}` : ''}`,
  async handler(a, rt, call) {
    return runCommand(
      { command: a.command, shell: a.shell, cwd: a.cwd || rt.paths.project.root, env: a.env, timeoutMs: a.timeout_ms, stdin: a.stdin, login: a.login, retries: a.retries, retryOn: a.retry_on },
      { config: rt.config, signal: call.signal },
    );
  },
});

export const terminalSession = defineTool({
  name: 'terminal_session',
  title: 'Interactive terminal session',
  description:
    'Persistent terminal sessions whose state (cwd, env, activated venvs, REPL variables) survives between calls. Actions: ' +
    '"start" (a shell, or `program` such as "python3 -i", "node", "ssh host"; `pty`=true gives a real pseudo-terminal on Linux/macOS for programs that need one), ' +
    '"send" (write `input`; for shells it waits until the command finishes and returns its exit_code; for programs it waits for `wait_for` regex or until output is idle), ' +
    '"read" (new output since last read; optionally wait for a regex), "signal" (SIGINT/SIGTERM/SIGKILL, e.g. to stop a running command), "close", "list".',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'send', 'read', 'signal', 'close', 'list'] },
      session: { type: 'string', description: 'Session id or name (send/read/signal/close).' },
      name: { type: 'string', description: 'Friendly name for a new session.' },
      shell: { type: 'string', enum: SHELLS },
      program: { type: 'string', description: 'Run this program instead of a shell (e.g. "python3 -i").' },
      pty: { type: 'boolean', description: 'Allocate a pseudo-terminal (Linux/macOS).' },
      cwd: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      input: { type: 'string', description: 'Text to send (a command for shells).' },
      newline: { type: 'boolean', description: 'Append a newline to input (default true).' },
      complete: { type: 'boolean', description: 'Wait for the shell command to complete and report its exit code (default true for shells).' },
      wait_for: { type: 'string', description: 'Regex to wait for in the output (e.g. a prompt like ">>> $").' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 3600000, description: 'Max time to wait (default 30000).' },
      idle_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'For programs: return once output is idle this long (default 800).' },
      signal: { type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'] },
      all: { type: 'boolean', description: 'read: return the whole buffer, not just new output.' },
      force: { type: 'boolean', description: 'close: kill immediately.' },
    },
    required: ['action'],
  },
  openWorld: true,
  assess(a, rt) {
    if (a.action === 'list' || a.action === 'read') return assessment('safe');
    if (a.action === 'start') return a.program ? classifyCommand(a.program, rt.policy.classifierOptions()) : assessment('low');
    if (a.action === 'send') {
      let kind = 'shell';
      try {
        kind = rt.sessions.get(a.session).shell.kind === 'program' ? 'program' : 'shell';
      } catch {
        /* unknown session — handler will report */
      }
      return kind === 'shell' ? classifyCommand(a.input ?? '', rt.policy.classifierOptions()) : classifyScript(a.input ?? '', rt.policy.classifierOptions());
    }
    return assessment('low');
  },
  summary: (a) => (a.action === 'send' ? `send to session ${a.session}: \`${String(a.input ?? '').slice(0, 120)}\`` : `terminal session ${a.action}${a.program ? ` ${a.program}` : ''}`),
  async handler(a, rt, call) {
    const sm = rt.sessions;
    switch (a.action) {
      case 'list':
        return { sessions: sm.list() };
      case 'start': {
        const s = sm.start({ shell: a.shell, cwd: a.cwd || rt.paths.project.root, env: a.env, name: a.name, command: a.program, pty: a.pty });
        // Give programs a moment to print their banner/prompt.
        const first = await s.read({ timeoutMs: a.program ? Math.min(a.timeout_ms ?? 3000, 10000) : 300, idleMs: a.program ? 500 : 200, waitFor: a.wait_for, signal: call.signal });
        return { ...s.summary(), output: first.output };
      }
      case 'send':
        need(a, 'session', 'input');
        return sm.get(a.session).send({ input: a.input, newline: a.newline ?? true, complete: a.complete, waitFor: a.wait_for, timeoutMs: a.timeout_ms ?? 30000, idleMs: a.idle_ms ?? 800, signal: call.signal });
      case 'read':
        need(a, 'session');
        return sm.get(a.session).read({ waitFor: a.wait_for, timeoutMs: a.timeout_ms ?? 0, idleMs: a.idle_ms ?? 0, signal: call.signal, all: a.all });
      case 'signal': {
        need(a, 'session');
        const s = sm.get(a.session);
        const d = s.signal(a.signal ?? 'SIGINT');
        const r = await s.read({ timeoutMs: 1500, idleMs: 300, signal: call.signal });
        return { ...r, signalled: a.signal ?? 'SIGINT', delivered: d?.delivered, note: d?.delivered === false ? 'Nothing was running in the session.' : undefined };
      }
      case 'close':
        need(a, 'session');
        return { closed: sm.close(a.session, { force: a.force }) };
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export const processTool = defineTool({
  name: 'process',
  title: 'Background & system processes',
  description:
    'Manage long-running background processes (dev servers, watchers, builds) and inspect OS processes. Actions: ' +
    '"start" (run `command` in the background with logs captured; wait for readiness via `ready_pattern` regex in output or `ready_port`), ' +
    '"status", "logs" (tail/grep the captured log), "stop" (managed process), "list" (managed processes), ' +
    '"system" (OS process table, `filter` by name/pid), "kill" (an OS process by `pid`; risky).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'status', 'logs', 'stop', 'list', 'system', 'kill'] },
      id: { type: 'string', description: 'Managed process id or name.' },
      command: { type: 'string' },
      name: { type: 'string' },
      shell: { type: 'string', enum: SHELLS },
      cwd: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      ready_pattern: { type: 'string', description: 'Regex that signals readiness, e.g. "listening on|ready in".' },
      ready_port: { type: 'integer', description: 'TCP port that signals readiness when it accepts connections.' },
      ready_timeout_ms: { type: 'integer', minimum: 0, maximum: 600000 },
      tail: { type: 'integer', minimum: 1, maximum: 5000, description: 'logs: number of lines (default 100).' },
      grep: { type: 'string', description: 'logs: only lines matching this regex.' },
      force: { type: 'boolean' },
      pid: { type: 'integer', description: 'kill: OS process id.' },
      filter: { type: 'string', description: 'system: name or pid filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    switch (a.action) {
      case 'start':
        return classifyCommand(a.command ?? '', rt.policy.classifierOptions({ cwd: a.cwd || rt.paths.project.root }));
      case 'stop':
        return assessment('low');
      case 'kill': {
        let name = '';
        try {
          const { processes } = await listSystemProcesses({ filter: String(a.pid), limit: 5 });
          name = processes.find((p) => p.pid === a.pid)?.name ?? '';
        } catch {
          /* ignore */
        }
        if (a.pid === process.pid) return assessment('forbidden', ['would kill the computer-skills server itself']);
        if (isSystemProcess(name) || a.pid <= 4) return assessment('critical', [`"${name || a.pid}" is a system process`], ['process']);
        return assessment('medium', [`terminates ${name || 'process'} (pid ${a.pid})`], ['process']);
      }
      default:
        return assessment('safe');
    }
  },
  summary: (a) => (a.action === 'start' ? `start background process \`${a.command}\`` : a.action === 'kill' ? `kill pid ${a.pid}${a.force ? ' (force)' : ''}` : `process ${a.action} ${a.id ?? ''}`),
  async handler(a, rt, call) {
    const pm = rt.processes;
    switch (a.action) {
      case 'start':
        need(a, 'command');
        return pm.start({ command: a.command, shell: a.shell, cwd: a.cwd || rt.paths.project.root, env: a.env, name: a.name, readyPattern: a.ready_pattern, readyPort: a.ready_port, readyTimeoutMs: a.ready_timeout_ms, signal: call.signal });
      case 'status':
        need(a, 'id');
        return pm.summary(pm.get(a.id), { tailLines: 15 });
      case 'logs':
        need(a, 'id');
        return pm.logs(a.id, { tail: a.tail, grep: a.grep });
      case 'stop':
        need(a, 'id');
        return pm.stop(a.id, { force: a.force });
      case 'list':
        return { processes: pm.list() };
      case 'system':
        return listSystemProcesses({ filter: a.filter, limit: a.limit ?? 50 });
      case 'kill':
        need(a, 'pid');
        await killPid(a.pid, { force: a.force });
        return { killed: a.pid, force: !!a.force };
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export function need(a, ...keys) {
  for (const k of keys) {
    if (a[k] === undefined || a[k] === null || a[k] === '') throw new ToolError(ErrorCode.INVALID_ARGUMENT, `"${k}" is required for action "${a.action}"`);
  }
}
