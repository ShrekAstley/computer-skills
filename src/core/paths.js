import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the installed package (the plugin root). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Expand a leading ~ and environment variables like $HOME / %USERPROFILE%. */
export function expandPath(p, env = process.env) {
  if (typeof p !== 'string' || !p) return p;
  let out = p;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = os.homedir() + out.slice(1);
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => (env[name] !== undefined ? env[name] : m));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => (env[name] !== undefined ? env[name] : m));
  return out;
}

/**
 * Directory that holds all persistent state (workflows, app profiles, context,
 * logs, screenshots, config). Overridable for tests and sandboxing.
 */
export function stateHome(env = process.env) {
  if (env.COMPUTER_SKILLS_HOME) return path.resolve(expandPath(env.COMPUTER_SKILLS_HOME, env));
  return path.join(os.homedir(), '.computer-skills');
}

/** The project directory the agent is working in. */
export function projectDir(env = process.env) {
  return path.resolve(env.COMPUTER_SKILLS_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd());
}

export function statePaths(env = process.env) {
  const home = stateHome(env);
  return {
    home,
    config: path.join(home, 'config.json'),
    workflows: path.join(home, 'workflows'),
    history: path.join(home, 'workflows', '.history'),
    apps: path.join(home, 'apps'),
    context: path.join(home, 'context'),
    logs: path.join(home, 'logs'),
    screenshots: path.join(home, 'screenshots'),
    tmp: path.join(home, 'tmp'),
    stopFile: path.join(home, 'STOP'),
  };
}

export function projectPaths(env = process.env) {
  const root = projectDir(env);
  const dir = path.join(root, '.computer-skills');
  return { root, dir, config: path.join(dir, 'config.json'), workflows: path.join(dir, 'workflows') };
}

/** Workflows shipped with the package (read-only, lowest priority). */
export const BUILTIN_WORKFLOWS = path.join(PACKAGE_ROOT, 'examples', 'workflows');

/** Turn arbitrary text into a filesystem/id friendly slug. */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}
