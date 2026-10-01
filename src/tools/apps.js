import path from 'node:path';
import fs from 'node:fs';
import { defineTool } from './registry.js';
import { need } from './terminal.js';
import { WINDOW_PROPS, windowSelector, assessment, blockedAppRisk } from './common.js';
import { classifyScript, isProtectedPath } from '../safety/classifier.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { resolveWindow, brief, selectWindows } from '../apps/windows.js';
import { expandPath } from '../core/paths.js';
import { sleep } from '../core/util.js';
import { run } from '../core/exec.js';

export const appTool = defineTool({
  name: 'app',
  title: 'Applications',
  description:
    'Discover, launch, inspect and quit desktop applications. Actions: ' +
    '"find" (search installed apps by name — use before launching an unfamiliar app), ' +
    '"launch" (start by `name` or `path`, waits until its window appears and returns it; if already running it focuses it unless if_running="new"), ' +
    '"status" (running? windows? focused?), "quit" (graceful; reports if a "save changes?" dialog blocks it; force=true kills), ' +
    '"open" (open a file/folder/URL with its default app; reveal=true shows it in the file manager), "adapters" (apps with built-in knowledge/scripting).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['find', 'launch', 'status', 'quit', 'open', 'adapters'] },
      name: { type: 'string', description: 'Application name, e.g. "Blender", "firefox", "Visual Studio Code".' },
      path: { type: 'string', description: 'Executable/app bundle path (launch), or file/URL (open).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments (launch).' },
      params: { type: 'object', description: 'Adapter launch parameters, e.g. {"file": "scene.blend"}, {"url": "..."}, {"project": "..."}.' },
      cwd: { type: 'string' },
      wait: { type: 'boolean', description: 'Wait for the window (default true).' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 300000, description: 'How long to wait for the window (default 30000).' },
      if_running: { type: 'string', enum: ['focus', 'new'], description: 'Behaviour when the app is already running (default focus).' },
      pid: { type: 'integer' },
      force: { type: 'boolean', description: 'quit: kill without saving.' },
      reveal: { type: 'boolean', description: 'open: reveal in file manager instead of opening.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      refresh: { type: 'boolean', description: 'find: rescan installed applications.' },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    switch (a.action) {
      case 'find': case 'status': case 'adapters':
        return assessment('safe');
      case 'launch': {
        const blocked = await blockedAppRisk(rt, { app: a.name ?? a.path });
        return blocked ?? assessment('low', [], ['launch']);
      }
      case 'quit':
        return a.force ? assessment('high', ['force-quitting discards unsaved work'], ['process']) : assessment('medium', ['closes an application (it may prompt to save)'], ['process']);
      case 'open': {
        const target = a.path ?? '';
        if (/^[a-z]+:\/\//i.test(target)) return assessment('low', [], ['open-url']);
        if (/\.(?:exe|msi|bat|cmd|ps1|sh|command|app|pkg|dmg|deb|rpm|appimage|jar|vbs|scr|run)$/i.test(target)) {
          return assessment('high', ['opening this file type executes or installs software'], ['execute']);
        }
        return assessment('low');
      }
      default:
        return assessment('low');
    }
  },
  summary: (a) => `${a.action} ${a.name ?? a.path ?? ''}${a.force ? ' (force)' : ''}`.trim(),
  async handler(a, rt, call) {
    const am = rt.apps;
    switch (a.action) {
      case 'find':
        return { query: a.name ?? '', results: await am.find(a.name ?? '', { limit: a.limit ?? 10, refresh: a.refresh }) };
      case 'adapters':
        return {
          adapters: rt.adapters.list().map((ad) => ({
            id: ad.id,
            name: ad.name,
            installed: !!rt.adapters.findExecutable(ad),
            scripting: ad.scripting?.language,
            knowledge: Object.keys(ad.knowledge || {}),
          })),
        };
      case 'launch': {
        if (!a.name && !a.path) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'launch needs name or path');
        const res = await am.launch({ name: a.name, path: a.path, args: a.args, params: a.params, cwd: a.cwd, wait: a.wait, timeoutMs: a.timeout_ms, ifRunning: a.if_running, signal: call.signal });
        if (res.adapter) {
          const profile = await rt.profiles.get(res.adapter).catch(() => null);
          if (profile?.adapter?.scripting) res.scripting_available = profile.adapter.scripting.language;
        }
        const wf = await rt.workflows.search({ app: res.app, limit: 5 }).catch(() => null);
        if (wf?.results?.length) res.known_workflows = wf.results.map((w) => ({ id: w.id, name: w.name, status: w.status }));
        return res;
      }
      case 'status':
        return am.status({ name: a.name, pid: a.pid });
      case 'quit':
        if (!a.name && !a.pid) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'quit needs name or pid');
        return am.quit({ name: a.name, pid: a.pid, force: a.force, timeoutMs: a.timeout_ms ?? 10000 });
      case 'open': {
        need(a, 'path');
        const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(a.path) && !/^[a-z]:[\\/]/i.test(a.path);
        const target = isUrl ? a.path : path.resolve(rt.paths.project.root, expandPath(a.path));
        if (!isUrl && !fs.existsSync(target)) throw new ToolError(ErrorCode.NOT_FOUND, `No such file: ${target}`);
        await rt.backend.openPath(target, { reveal: a.reveal });
        await sleep(800);
        const active = await rt.backend.activeWindow().catch(() => null);
        return { opened: target, reveal: !!a.reveal, focused_window: brief(active), hint: 'Verify the expected app/window opened (verify window_exists) before interacting.' };
      }
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export const appScript = defineTool({
  name: 'app_script',
  title: 'Run an app\'s scripting interface',
  description:
    'Automate an application through its native scripting/CLI interface instead of the GUI — far more reliable when available. ' +
    'Blender: Python/bpy (`code`; background=true runs headless and returns stdout; `file` opens a .blend first). ' +
    'Godot: GDScript (`code` extending SceneTree, optional options.project) or raw `args`. Unity: options {project, method} (-executeMethod, batch mode). ' +
    'Chrome/Chromium/Edge: options {operation: dump_dom|screenshot|pdf, url, output}. VS Code: `args` for the code CLI. Photoshop: ExtendScript `code`. ' +
    'Use app action "adapters" to list what is installed. Code is risk-classified (file deletion / subprocesses need approval).',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'Adapter id or app name (blender, godot, unity, chrome, chromium, edge, firefox, vscode, photoshop).' },
      code: { type: 'string', description: 'Script source in the app\'s language.' },
      file: { type: 'string', description: 'Document/project to open first (e.g. a .blend file).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Raw CLI arguments (adapters that accept them).' },
      background: { type: 'boolean', description: 'Run headless where supported (default true).' },
      options: { type: 'object', description: 'Adapter-specific options (e.g. {"operation": "pdf", "url": "...", "output": "..."}).' },
      executable: { type: 'string', description: 'Override the app executable path.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 7200000 },
    },
    required: ['app'],
  },
  async assess(a, rt) {
    const blocked = await blockedAppRisk(rt, { app: a.app });
    if (blocked) return blocked;
    if (a.code) return classifyScript(a.code, rt.policy.classifierOptions());
    const out = a.options?.output ? path.resolve(rt.paths.project.root, expandPath(a.options.output)) : null;
    if (out && isProtectedPath(out, rt.policy.protectedPaths)) return assessment('critical', [`writes to protected path ${out}`], ['overwrite']);
    if (a.args?.some((x) => /--install-extension|--uninstall-extension/.test(x))) return assessment('high', ['installs or removes editor extensions'], ['install']);
    return assessment('medium', ['runs an application in automation mode'], ['app-script']);
  },
  summary: (a) => `run ${a.app} script${a.code ? `: ${a.code.split('\n')[0].slice(0, 100)}` : a.args ? ` ${a.args.join(' ')}` : ''}`,
  async handler(a, rt, call) {
    const adapter = rt.adapters.get(a.app) ?? rt.adapters.match(a.app);
    if (!adapter) throw new ToolError(ErrorCode.NOT_FOUND, `No adapter for "${a.app}"`, { hint: 'Apps without an adapter are driven through the GUI (window/ui_*/input_* tools) or terminal_run.' });
    if (!adapter.scripting) {
      throw new ToolError(ErrorCode.UNSUPPORTED, `${adapter.name} has no external scripting interface`, {
        hint: (adapter.knowledge?.tips || []).join(' ') || 'Drive it through the GUI.',
      });
    }
    const executable = a.executable ? path.resolve(expandPath(a.executable)) : rt.adapters.findExecutable(adapter);
    if (!executable && adapter.id !== 'photoshop') throw new ToolError(ErrorCode.NOT_FOUND, `${adapter.name} is not installed (executable not found)`, { hint: 'Pass `executable`, or check app action "find".' });
    const ctx = {
      executable,
      paths: rt.paths,
      signal: call.signal,
      appName: adapter.name,
      run, // exec helper for adapters: run(cmd, args, {timeoutMs, signal, cwd, env, input})
      launch: async (args) => rt.apps.launch({ path: executable, name: adapter.name, args, ifRunning: 'new', signal: call.signal }),
    };
    const req = { ...(a.options || {}), code: a.code, file: a.file ? path.resolve(rt.paths.project.root, expandPath(a.file)) : undefined, args: a.args, background: a.background ?? true, timeoutMs: a.timeout_ms };
    for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k];
    if (req.output) req.output = path.resolve(rt.paths.project.root, expandPath(req.output));
    if (req.project) req.project = path.resolve(rt.paths.project.root, expandPath(req.project));
    const res = await adapter.scripting.run(ctx, req);
    return { app: adapter.name, language: adapter.scripting.language, ...res };
  },
});

export const windowTool = defineTool({
  name: 'window',
  title: 'Windows',
  description:
    'List and manage windows. Actions: "list" (all top-level windows with id, title, app, pid, bounds, focused), "active" (the focused window), ' +
    '"focus", "minimize", "maximize", "restore", "fullscreen", "close" (asks the app to close; it may prompt to save), "move" (x,y), "resize" (width,height). ' +
    'Select the window with window_id (exact), title (fuzzy), title_regex, app or pid. Focus a window before sending keyboard input to it.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'active', 'focus', 'minimize', 'maximize', 'restore', 'fullscreen', 'close', 'move', 'resize'] },
      ...WINDOW_PROPS,
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      filter: { type: 'string', description: 'list: only windows whose title/app contains this text.' },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    if (a.action === 'list' || a.action === 'active') return assessment('safe');
    const blocked = await blockedAppRisk(rt, { selector: windowSelector(a) });
    if (blocked) return blocked;
    if (a.action === 'close') return assessment('medium', ['closes a window (unsaved work may prompt)'], ['close']);
    return assessment('low');
  },
  summary: (a) => `${a.action} window ${JSON.stringify(windowSelector(a))}`,
  async handler(a, rt) {
    const b = rt.backend;
    if (a.action === 'list') {
      let wins = await b.listWindows();
      if (a.filter) wins = wins.filter((w) => `${w.title} ${w.app}`.toLowerCase().includes(a.filter.toLowerCase()));
      const sel = windowSelector(a);
      if (Object.keys(sel).length) wins = selectWindows(wins, sel);
      return { count: wins.length, windows: wins.map(brief) };
    }
    if (a.action === 'active') return { window: brief(await b.activeWindow()) };
    const win = await resolveWindow(b, windowSelector(a));
    if (a.action === 'move' && (a.x === undefined || a.y === undefined)) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'move needs x and y');
    if (a.action === 'resize' && (a.width === undefined || a.height === undefined)) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'resize needs width and height');
    await b.windowAction(win.id, a.action, { x: a.x, y: a.y, width: a.width, height: a.height });
    await sleep(250);
    const after = (await b.listWindows()).find((w) => w.id === win.id) ?? null;
    const res = { action: a.action, window: brief(win), after: brief(after) };
    if (a.action === 'close') {
      res.closed = !after;
      if (after) res.hint = 'The window is still open — likely a confirmation dialog appeared. Check with ui_dialog detect.';
    }
    if (a.action === 'focus') {
      res.focused = !!after?.focused;
      if (after && !after.focused) res.hint = 'The window manager refused focus (focus stealing prevention). Try clicking the window or restoring it first.';
    }
    return res;
  },
});
