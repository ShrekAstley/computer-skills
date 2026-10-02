import path from 'node:path';
import { which, IS_WIN } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';

/**
 * Shell discovery and invocation. The agent can ask for a specific shell
 * ("bash", "zsh", "fish", "sh", "pwsh", "powershell", "cmd") or "auto",
 * which picks the most capable shell for the OS.
 */

const UNIX_SHELLS = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'pwsh'];
const WIN_SHELLS = ['pwsh', 'powershell', 'cmd', 'bash'];

export function shellKind(name) {
  const base = path.basename(String(name)).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  if (base === 'cmd') return 'cmd';
  if (base === 'fish') return 'fish';
  return 'posix';
}

export function availableShells(platform = process.platform) {
  const names = platform === 'win32' ? WIN_SHELLS : UNIX_SHELLS;
  const out = [];
  for (const n of names) {
    let p = which(n);
    if (platform === 'win32' && n === 'bash' && p && /\\system32\\bash\.exe$/i.test(p)) p = null; // WSL launcher; use `wsl` explicitly
    if (platform === 'win32' && n === 'powershell' && !p) {
      const sys = process.env.SystemRoot || 'C:\\Windows';
      p = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    if (platform === 'win32' && n === 'cmd' && !p) p = process.env.ComSpec || 'cmd.exe';
    if (p) out.push({ name: n, path: p, kind: shellKind(n) });
  }
  return out;
}

export function defaultShell(config, platform = process.platform) {
  const preferred = config?.terminal?.defaultShell;
  const shells = availableShells(platform);
  if (preferred) {
    const hit = shells.find((s) => s.name === preferred);
    if (hit) return hit;
  }
  if (platform === 'win32') return shells.find((s) => s.name === 'pwsh') ?? shells.find((s) => s.name === 'powershell') ?? shells.find((s) => s.name === 'cmd');
  const userShell = process.env.SHELL ? path.basename(process.env.SHELL) : null;
  if (userShell && ['bash', 'zsh'].includes(userShell)) {
    const hit = shells.find((s) => s.name === userShell);
    if (hit) return hit;
  }
  return shells.find((s) => s.name === 'bash') ?? shells.find((s) => s.name === 'zsh') ?? shells.find((s) => s.name === 'sh');
}

export function resolveShell(requested, config, platform = process.platform) {
  if (!requested || requested === 'auto' || requested === 'default') {
    const s = defaultShell(config, platform);
    if (!s) throw new ToolError(ErrorCode.DEPENDENCY_MISSING, 'No usable shell found on PATH');
    return s;
  }
  const shells = availableShells(platform);
  const hit = shells.find((s) => s.name === requested) ?? (which(requested) ? { name: requested, path: which(requested), kind: shellKind(requested) } : null);
  if (!hit) {
    throw new ToolError(ErrorCode.NOT_FOUND, `Shell "${requested}" is not available`, {
      hint: `Available shells: ${shells.map((s) => s.name).join(', ') || 'none'}`,
    });
  }
  return hit;
}

/** Wrap a PowerShell script so native exit codes and cmdlet failures propagate. */
export function wrapPowerShell(command) {
  return `$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`;
}

/** argv for running `command` once in `shell`. */
export function oneShotInvocation(shell, command, { login = false } = {}) {
  switch (shell.kind) {
    case 'powershell':
      return {
        cmd: shell.path,
        // -OutputFormat Text keeps errors human-readable (otherwise redirected stderr is CLIXML).
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(wrapPowerShell(command), 'utf16le').toString('base64')],
      };
    case 'cmd':
      return { cmd: shell.path, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
    case 'fish':
      return { cmd: shell.path, args: login ? ['-l', '-c', command] : ['-c', command] };
    default:
      return { cmd: shell.path, args: login ? ['-l', '-c', command] : ['-c', command] };
  }
}

/** argv for a persistent session that reads commands from stdin. */
export function sessionInvocation(shell) {
  switch (shell.kind) {
    case 'powershell':
      return { cmd: shell.path, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'] };
    case 'cmd':
      return { cmd: shell.path, args: ['/d', '/q', '/k', 'prompt $S'] };
    case 'fish':
      return { cmd: shell.path, args: ['--no-config'] };
    default:
      return { cmd: shell.path, args: path.basename(shell.path).startsWith('bash') ? ['--noprofile', '--norc'] : [] };
  }
}

/** Lines that make the shell print a completion marker with the exit status. */
export function completionMarker(shell, token) {
  switch (shell.kind) {
    case 'powershell':
      // $? must be read first; $LASTEXITCODE is reset before each command (see commandPrefix).
      return `$__csok = $?; Write-Output ("__CS_DONE_${token}_" + $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__csok) { 0 } else { 1 }) + "__")`;
    case 'cmd':
      return `echo __CS_DONE_${token}_%ERRORLEVEL%__`;
    case 'fish':
      return `printf '\\n__CS_DONE_${token}_%s__\\n' $status`;
    default:
      return `printf '\\n__CS_DONE_${token}_%s__\\n' "$?"`;
  }
}

/** Line sent before each command in a session (PowerShell keeps $LASTEXITCODE across commands). */
export function commandPrefix(shell) {
  return shell.kind === 'powershell' ? '$global:LASTEXITCODE = 0\n' : '';
}

export const MARKER_RE = /__CS_DONE_([a-z0-9]+)_(-?\d+)__/;

export { IS_WIN };
