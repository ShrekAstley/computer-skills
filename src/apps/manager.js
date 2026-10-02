import fs from 'node:fs';
import path from 'node:path';
import { run, which } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { matchScore, sleep, normText } from '../core/util.js';
import { expandPath } from '../core/paths.js';
import { selectWindows, brief } from './windows.js';
import { listSystemProcesses, isPidRunning, killPid } from '../terminal/processes.js';
import { osName } from '../platform/index.js';

/**
 * Application lifecycle: discovery, launch with readiness detection, status,
 * and quitting. Combines the OS backend (installed apps, windows) with
 * adapters (executables, window patterns, version probes).
 */
export class AppManager {
  constructor({ backend, adapters, config, paths, logger }) {
    this.backend = backend;
    this.adapters = adapters;
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this._installed = null;
    this._installedAt = 0;
    this.launched = new Map(); // pid -> {name, adapter, at}
  }

  async installed({ refresh = false } = {}) {
    if (!refresh && this._installed && Date.now() - this._installedAt < 10 * 60 * 1000) return this._installed;
    let apps = [];
    try {
      apps = await this.backend.listApps();
    } catch (err) {
      this.logger?.warn?.('listApps failed', { error: err.message });
    }
    this._installed = apps;
    this._installedAt = Date.now();
    return apps;
  }

  /** Search installed apps + adapters for a name. */
  async find(query, { limit = 10, refresh = false, includeHidden = false } = {}) {
    const apps = await this.installed({ refresh });
    const results = [];
    const q = normText(query || '');
    for (const a of apps) {
      if (a.hidden && !includeHidden) continue;
      const s = q ? Math.max(matchScore(q, a.name), matchScore(q, a.id) * 0.95, a.genericName ? matchScore(q, a.genericName) * 0.7 : 0, a.keywords && normText(a.keywords).includes(q) ? 0.6 : 0) : 0.5;
      if (s > 0) results.push({ score: s, name: a.name, id: a.id, path: a.path, exec: a.exec, appId: a.appId, source: a.source, adapter: this.adapters.match(a.name)?.id });
    }
    for (const ad of this.adapters.list()) {
      const s = q ? Math.max(matchScore(q, ad.name), ...ad.aliases.map((x) => matchScore(q, x)), matchScore(q, ad.id)) : 0.4;
      if (s <= 0) continue;
      const exe = this.adapters.findExecutable(ad);
      if (!exe) continue;
      if (results.some((r) => r.adapter === ad.id && r.score >= s)) continue;
      results.push({ score: s, name: ad.name, id: ad.id, path: exe, source: 'adapter', adapter: ad.id });
    }
    // Plain executables on PATH (CLI apps, or GUI apps without desktop entries)
    if (q && !q.includes(' ') && which(query)) {
      results.push({ score: 0.75, name: query, id: query, path: which(query), source: 'path', adapter: this.adapters.match(query)?.id });
    }
    results.sort((a, b) => b.score - a.score);
    const dedup = [];
    const seen = new Set();
    for (const r of results) {
      const k = (r.path || r.appId || r.name).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push({ ...r, score: Math.round(r.score * 100) / 100 });
    }
    return dedup.slice(0, limit);
  }

  /** Resolve something launchable from a name or path. */
  async resolve({ name, path: p }) {
    if (p) {
      const abs = path.resolve(expandPath(p));
      if (!fs.existsSync(abs) && !which(p)) throw new ToolError(ErrorCode.NOT_FOUND, `No such application path: ${p}`);
      return { entry: { name: name || path.basename(abs), path: fs.existsSync(abs) ? abs : which(p), command: fs.existsSync(abs) ? undefined : which(p) }, adapter: this.adapters.match(name || path.basename(abs, path.extname(abs))) };
    }
    if (!name) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Provide an app name or path');
    const adapter = this.adapters.match(name);
    if (adapter) {
      const exe = this.adapters.findExecutable(adapter);
      if (exe) {
        // On macOS prefer launching the bundle so the app registers normally.
        const bundle = process.platform === 'darwin' ? exe.match(/^(.*?\.app)\//)?.[1] : null;
        return { entry: { name: adapter.name, path: bundle || exe, executable: exe }, adapter };
      }
    }
    const hits = await this.find(name, { limit: 5, includeHidden: true });
    const best = hits[0];
    if (!best || best.score < 0.6) {
      throw new ToolError(ErrorCode.NOT_FOUND, `Application "${name}" was not found on this computer`, {
        hint: 'Check the exact name with app action "find", pass a path, or ask the user whether it is installed. Installing software requires approval.',
        details: { candidates: hits.slice(0, 5).map((h) => h.name) },
      });
    }
    const ad = adapter ?? (best.adapter ? this.adapters.get(best.adapter) : null);
    return { entry: { name: best.name, path: best.path, exec: best.exec, appId: best.appId, executable: ad ? this.adapters.findExecutable(ad) : undefined }, adapter: ad };
  }

  async descendants(pid) {
    const set = new Set([Number(pid)]);
    if (process.platform === 'win32' || !pid) return set;
    try {
      const { processes } = await listSystemProcesses({ limit: 100000 });
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of processes) if (set.has(p.ppid) && !set.has(p.pid)) {
          set.add(p.pid);
          grew = true;
        }
      }
    } catch {
      /* best effort */
    }
    return set;
  }

  /** Windows that belong to an app (by pid tree, adapter pattern, or name). */
  async windowsFor({ name, pid, adapter }, windows) {
    const wins = windows ?? (await this.backend.listWindows());
    const out = new Map();
    if (pid) {
      const pids = await this.descendants(pid);
      for (const w of wins) if (pids.has(Number(w.pid))) out.set(w.id, w);
    }
    if (adapter?.window?.titlePattern) {
      const re = new RegExp(adapter.window.titlePattern, 'i');
      for (const w of wins) if (re.test(w.title) || re.test(w.app || '')) out.set(w.id, w);
    }
    if (name && !out.size) for (const w of selectWindows(wins, { app: name })) out.set(w.id, w);
    return [...out.values()];
  }

  /**
   * Launch and wait until a window appears.
   * @param {{name?: string, path?: string, args?: string[], params?: object, cwd?: string,
   *          wait?: boolean, timeoutMs?: number, ifRunning?: 'focus'|'new', signal?: AbortSignal}} req
   */
  async launch(req) {
    const { entry, adapter } = await this.resolve(req);
    const appName = adapter?.name ?? entry.name;
    const before = await this.backend.listWindows().catch(() => []);
    if ((req.ifRunning ?? 'focus') === 'focus') {
      const existing = await this.windowsFor({ name: appName, adapter }, before);
      if (existing.length) {
        const w = existing.sort((a, b) => Number(!!b.focused) - Number(!!a.focused))[0];
        await this.backend.windowAction(w.id, 'focus').catch(() => {});
        return { status: 'already-running', app: appName, adapter: adapter?.id, window: brief(w), windows: existing.map(brief), note: 'Focused the existing window. Pass if_running "new" to start another instance.' };
      }
    }
    const args = [...(adapter?.launchArgs?.({ params: req.params || {} }) ?? []), ...(req.args || [])];
    const logFile = path.join(this.paths.logs, 'apps', `${(adapter?.id ?? normText(appName).replace(/\W+/g, '-')) || 'app'}-${Date.now()}.log`);
    const started = Date.now();
    const { pid, argv } = await this.backend.launch(entry, { args, cwd: req.cwd ? path.resolve(expandPath(req.cwd)) : undefined, logFile });
    if (pid) this.launched.set(pid, { name: appName, adapter: adapter?.id, at: started, logFile });
    const res = { status: 'launched', app: appName, adapter: adapter?.id, pid, argv, log_file: logFile };
    if (req.wait === false) return res;

    const timeoutMs = req.timeoutMs ?? 30000;
    const beforeIds = new Set(before.map((w) => w.id));
    const end = Date.now() + timeoutMs;
    let found = [];
    while (Date.now() < end) {
      if (req.signal?.aborted) break;
      const wins = await this.backend.listWindows().catch(() => []);
      const mine = await this.windowsFor({ name: appName, pid, adapter }, wins);
      found = mine.filter((w) => !beforeIds.has(w.id));
      if (!found.length && pid) found = mine.filter((w) => w.pid === pid);
      if (found.length) break;
      if (pid && !isPidRunning(pid) && Date.now() - started > 3000) {
        // The launcher may have handed off to an existing instance; check by name.
        const byName = await this.windowsFor({ name: appName, adapter }, wins);
        if (byName.length) {
          found = byName;
          break;
        }
      }
      await sleep(400);
    }
    res.waited_ms = Date.now() - started;
    if (found.length) {
      res.ready = true;
      res.window = brief(found[0]);
      if (found.length > 1) res.windows = found.map(brief);
    } else {
      res.ready = false;
      res.process_running = pid ? isPidRunning(pid) : undefined;
      res.hint = res.process_running === false
        ? 'The process exited without showing a window. Check log_file for errors, or the app may need different arguments.'
        : `No window appeared within ${timeoutMs}ms. The app may still be starting (use verify window_exists with a longer timeout), may show its window on another workspace, or may be a background/CLI app.`;
      try {
        const log = fs.readFileSync(logFile, 'utf8').trim();
        if (log) res.log_tail = log.split('\n').slice(-15).join('\n');
      } catch {
        /* no log */
      }
    }
    if (adapter?.version) res.version = await this.version(adapter, entry.executable || entry.path).catch(() => undefined);
    return res;
  }

  async version(adapter, executable) {
    if (!adapter?.version || !executable || executable.endsWith('.app')) return undefined;
    const r = await run(executable, adapter.version.args, { timeoutMs: 15000 });
    const m = (r.stdout + r.stderr).match(new RegExp(adapter.version.pattern, 'm'));
    return m?.[1];
  }

  async status({ name, pid }) {
    const adapter = name ? this.adapters.match(name) : null;
    const wins = await this.backend.listWindows().catch(() => []);
    const windows = await this.windowsFor({ name: adapter?.name ?? name, pid, adapter }, wins);
    let processes = [];
    if (name || pid) {
      const filter = pid ? String(pid) : adapter?.locate?.[osName()]?.executables?.[0]?.replace(/\.exe$/i, '') ?? name;
      processes = (await listSystemProcesses({ filter, limit: 20 }).catch(() => ({ processes: [] }))).processes;
    }
    return {
      app: adapter?.name ?? name,
      adapter: adapter?.id,
      running: windows.length > 0 || processes.length > 0,
      windows: windows.map(brief),
      processes: processes.slice(0, 10),
      focused: windows.some((w) => w.focused),
    };
  }

  /** Quit gracefully (close windows / ask the app), optionally force-kill. */
  async quit({ name, pid, force = false, timeoutMs = 10000 }) {
    const st = await this.status({ name, pid });
    if (!st.running) return { status: 'not-running', app: st.app };
    if (!force) {
      if (process.platform === 'darwin' && this.backend.quitApp && name) {
        await this.backend.quitApp({ name: st.app }).catch(() => {});
      } else {
        for (const w of st.windows) await this.backend.windowAction(w.id, 'close').catch(() => {});
      }
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        await sleep(400);
        const now = await this.status({ name, pid });
        if (!now.windows.length) return { status: 'quit', app: st.app };
      }
      const now = await this.status({ name, pid });
      return {
        status: 'still-running',
        app: st.app,
        windows: now.windows,
        hint: 'The app did not close. It is probably showing a confirmation dialog ("Save changes?"). Inspect it with screen_capture / ui_dialog and decide, or retry with force=true (unsaved work is lost).',
      };
    }
    const pids = new Set(st.windows.map((w) => w.pid).filter(Boolean));
    if (pid) pids.add(Number(pid));
    // Only exact executable-name matches: substring matches ("code") could hit unrelated processes.
    const adapter = name ? this.adapters.match(name) : null;
    const exeNames = new Set([...(adapter?.locate?.[osName()]?.executables ?? []), name ?? ''].map((n) => n.toLowerCase().replace(/\.exe$/, '')).filter(Boolean));
    for (const p of st.processes) if (!pid && exeNames.has(p.name.toLowerCase().replace(/\.exe$/, ''))) pids.add(p.pid);
    for (const p of pids) await killPid(p, { force: true }).catch(() => {});
    return { status: 'killed', app: st.app, pids: [...pids] };
  }
}
