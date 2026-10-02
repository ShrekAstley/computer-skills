import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../core/paths.js';
import { writeJsonAtomic } from '../core/fsutil.js';
import { run, which } from '../core/exec.js';

const SERVER_NAME = 'computer-skills';

/** Strip // and /* *\/ comments (and trailing commas) from JSONC, respecting strings. */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { data: {}, hadComments: false, existed: false };
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = stripJsonComments(raw);
  return { data: stripped.trim() ? JSON.parse(stripped) : {}, hadComments: stripped.replace(/\s/g, '') !== raw.replace(/\s/g, '').replace(/,(?=[}\]])/g, ''), existed: true };
}

export function serverCommand(serverPath) {
  const bin = serverPath ? path.resolve(serverPath) : path.join(PACKAGE_ROOT, 'bin', 'computer-skills.js');
  // Absolute node path: GUI apps (Cursor) often lack the shell PATH (nvm, Homebrew).
  return { command: process.execPath, args: [bin, 'serve'] };
}

/**
 * Register the MCP server with a client.
 * @param {{target: 'claude'|'cursor'|'opencode', scope?: 'user'|'project', dryRun?: boolean, serverPath?: string, name?: string, cwd?: string, home?: string}} opts
 */
export async function installClientConfig({ target, scope = 'user', dryRun = false, serverPath, name = SERVER_NAME, cwd = process.cwd(), home = os.homedir() }) {
  const { command, args } = serverCommand(serverPath);
  switch (target) {
    case 'cursor': {
      const file = scope === 'project' ? path.join(cwd, '.cursor', 'mcp.json') : path.join(home, '.cursor', 'mcp.json');
      return mergeJson(file, (cfg) => {
        cfg.mcpServers = { ...(cfg.mcpServers || {}), [name]: { command, args, env: {} } };
        return cfg;
      }, dryRun);
    }
    case 'opencode': {
      const dir = scope === 'project' ? cwd : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
      const jsonc = path.join(dir, 'opencode.jsonc');
      const file = fs.existsSync(jsonc) ? jsonc : path.join(dir, 'opencode.json');
      return mergeJson(file, (cfg) => {
        if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
        cfg.mcp = { ...(cfg.mcp || {}), [name]: { type: 'local', command: [command, ...args], enabled: true } };
        return cfg;
      }, dryRun);
    }
    case 'claude': {
      if (scope === 'project') {
        const file = path.join(cwd, '.mcp.json');
        return mergeJson(file, (cfg) => {
          cfg.mcpServers = { ...(cfg.mcpServers || {}), [name]: { command, args } };
          return cfg;
        }, dryRun);
      }
      const claude = which('claude');
      const cli = ['mcp', 'add', '--scope', 'user', name, '--', command, ...args];
      if (!claude || dryRun) return { target, scope, command: ['claude', ...cli].join(' '), applied: false, note: claude ? 'dry run' : 'claude CLI not found; run the command above once it is installed, or install the plugin with /plugin.' };
      const r = await run(claude, cli, { timeoutMs: 30000 });
      return { target, scope, applied: r.code === 0, output: (r.stdout + r.stderr).trim() };
    }
    default:
      throw new Error(`Unknown target "${target}" (expected claude, cursor or opencode)`);
  }
}

async function mergeJson(file, mutate, dryRun) {
  const { data, hadComments, existed } = readConfig(file);
  const next = mutate(JSON.parse(JSON.stringify(data)));
  const snippet = JSON.stringify(next, null, 2);
  if (hadComments) {
    return { file, applied: false, note: 'The file contains comments; not rewriting it. Add this configuration manually:', config: next };
  }
  if (!dryRun) {
    if (existed) fs.copyFileSync(file, file + '.bak');
    await writeJsonAtomic(file, next);
  }
  return { file, applied: !dryRun, backup: existed && !dryRun ? file + '.bak' : undefined, config: dryRun ? JSON.parse(snippet) : undefined };
}
