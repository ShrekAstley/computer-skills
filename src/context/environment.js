import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { run, which } from '../core/exec.js';
import { readJson, writeJsonAtomic } from '../core/fsutil.js';
import { mapLimit, nowIso } from '../core/util.js';
import { availableShells, defaultShell } from '../terminal/shells.js';
import { osName } from '../platform/index.js';
import { listSystemProcesses } from '../terminal/processes.js';

/** Developer/system tools worth knowing about, with how to read their version. */
const TOOLS = [
  ['git', ['--version']], ['node', ['--version']], ['npm', ['--version']], ['pnpm', ['--version']], ['yarn', ['--version']], ['bun', ['--version']], ['deno', ['--version']],
  ['python3', ['--version']], ['python', ['--version']], ['pip3', ['--version']], ['uv', ['--version']], ['conda', ['--version']],
  ['go', ['version']], ['cargo', ['--version']], ['rustc', ['--version']], ['java', ['-version']], ['dotnet', ['--version']], ['gcc', ['--version']], ['clang', ['--version']], ['make', ['--version']], ['cmake', ['--version']],
  ['docker', ['--version']], ['podman', ['--version']], ['kubectl', ['version', '--client']], ['gh', ['--version']], ['code', ['--version']], ['cursor', ['--version']],
  ['brew', ['--version']], ['apt', ['--version']], ['dnf', ['--version']], ['pacman', ['--version']], ['zypper', ['--version']], ['snap', ['--version']], ['flatpak', ['--version']],
  ['winget', ['--version']], ['choco', ['--version']], ['scoop', ['--version']],
  ['blender', ['--version']], ['godot', ['--version']], ['ffmpeg', ['-version']], ['magick', ['--version']], ['convert', ['--version']], ['tesseract', ['--version']],
  ['xdotool', ['--version']], ['wmctrl', ['--version']], ['ydotool', ['--help']], ['grim', ['-h']], ['cliclick', ['-V']],
];

export const SECTIONS = ['system', 'session', 'displays', 'shells', 'tools', 'capabilities', 'dirs', 'apps', 'processes', 'safety'];

/**
 * Builds and persists a model of the computer: OS, displays, shells, tools,
 * installed apps, important directories, capabilities, and running processes.
 * Cached on disk (context/environment.json) and refreshed when stale, so a
 * new session starts with what the last one learned.
 */
export class EnvironmentContext {
  constructor({ backend, apps, policy, config, paths, logger }) {
    this.backend = backend;
    this.apps = apps;
    this.policy = policy;
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this.file = path.join(paths.context, 'environment.json');
  }

  async load() {
    return readJson(this.file, null).catch(() => null);
  }

  async inspect({ sections = ['system', 'session', 'displays', 'shells', 'tools', 'capabilities', 'dirs', 'safety'], refresh = false } = {}) {
    const wanted = new Set(sections.includes('all') ? SECTIONS : sections);
    const cached = refresh ? null : await this.load();
    const maxAge = (this.config.context?.maxAgeMinutes ?? 60) * 60000;
    const fresh = cached && Date.now() - Date.parse(cached.updated) < maxAge;
    const out = { updated: nowIso() };
    const persisted = { ...(cached || {}) };

    const reuse = (key) => fresh && cached[key] !== undefined && !['session', 'displays', 'processes', 'safety'].includes(key);

    const tasks = {
      system: async () => this.system(),
      session: async () => ({ backend: this.backend.name, ...this.backend.info() }),
      displays: async () => this.backend.screens().catch((err) => ({ error: err.message })),
      shells: async () => ({ default: defaultShell(this.config)?.name, available: availableShells() }),
      tools: async () => this.tools(),
      capabilities: async () => this.backend.capabilities().catch((err) => ({ error: err.message })),
      dirs: async () => this.dirs(),
      apps: async () => {
        const apps = await this.apps.installed({ refresh });
        return { count: apps.length, apps: apps.filter((a) => !a.hidden).slice(0, 400).map((a) => a.name).sort() };
      },
      processes: async () => listSystemProcesses({ limit: 25 }).catch((err) => ({ error: err.message })),
      safety: async () => ({ level: this.policy.level, stopped: this.policy.isStopped(), config_sources: this.config._sources }),
    };
    await Promise.all(
      [...wanted].filter((k) => tasks[k]).map(async (k) => {
        out[k] = reuse(k) ? cached[k] : await tasks[k]();
        if (!['processes', 'safety'].includes(k)) persisted[k] = out[k];
      }),
    );
    if (fresh) out.cached_from = cached.updated;
    persisted.updated = fresh ? cached.updated : out.updated;
    await writeJsonAtomic(this.file, persisted).catch((err) => this.logger?.warn?.('failed to persist context', { error: err.message }));
    return out;
  }

  system() {
    return {
      os: osName(),
      platform: process.platform,
      release: os.release(),
      version: typeof os.version === 'function' ? os.version() : undefined,
      arch: process.arch,
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
      cpus: os.cpus().length,
      memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      free_memory_gb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
      node: process.version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cwd: process.cwd(),
      path_entries: (process.env.PATH || process.env.Path || '').split(path.delimiter).length,
    };
  }

  async tools() {
    const found = TOOLS.filter(([name]) => which(name));
    const versions = await mapLimit(found, 8, async ([name, args]) => {
      try {
        const r = await run(which(name), args, { timeoutMs: 4000 });
        const text = `${r.stdout}\n${r.stderr}`.trim();
        const m = text.match(/\d+\.\d+(?:\.\d+)?/);
        return [name, { path: which(name), version: m?.[0] }];
      } catch {
        return [name, { path: which(name) }];
      }
    });
    return Object.fromEntries(versions);
  }

  dirs() {
    const home = os.homedir();
    const candidates = {
      home,
      desktop: path.join(home, 'Desktop'),
      documents: path.join(home, 'Documents'),
      downloads: path.join(home, 'Downloads'),
      pictures: path.join(home, 'Pictures'),
      temp: os.tmpdir(),
      project: this.paths.project?.root ?? process.cwd(),
      state: this.paths.home,
    };
    if (process.platform === 'linux') {
      // Honour XDG user dirs (localised folder names).
      try {
        const txt = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
        for (const m of txt.matchAll(/XDG_(\w+)_DIR="([^"]+)"/g)) {
          const key = m[1].toLowerCase();
          if (candidates[key] !== undefined) candidates[key] = m[2].replace('$HOME', home);
        }
      } catch {
        /* defaults */
      }
    }
    return Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, v && fs.existsSync(v) ? v : v ? `${v} (missing)` : null]));
  }
}
