import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { Backend } from './base.js';
import { run, runOk, which, spawnDetached, runWithInputDetached } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { toMacSystemEvents, MAC_KEYCODES } from '../core/keys.js';
import { PACKAGE_ROOT } from '../core/paths.js';
import { pngSize } from '../screen/png.js';
import { sleep } from '../core/util.js';

const HELPER = path.join(PACKAGE_ROOT, 'src', 'platform', 'helpers', 'macos_helper.jxa');

const PERMISSION_HINT =
  'Grant Accessibility (and Screen Recording for screenshots/window titles) to the app running the agent ' +
  '(Terminal, iTerm, VS Code, Cursor, …) in System Settings → Privacy & Security, then restart that app.';

/**
 * macOS backend: CoreGraphics events (via JXA's ObjC bridge) for the mouse,
 * System Events for keyboard/windows/accessibility/menus, `screencapture`
 * for pixels and the Vision framework for OCR. No third-party installs needed;
 * `cliclick` is used for clicks when present because it is slightly faster.
 */
export class MacBackend extends Backend {
  get name() {
    return 'macos';
  }

  info() {
    return { os: 'macos', release: os.release() };
  }

  async helper(op, args = {}, { timeoutMs = 30000 } = {}) {
    const r = await run('osascript', ['-l', 'JavaScript', HELPER, op, JSON.stringify(args)], { timeoutMs });
    if (r.timedOut) throw new ToolError(ErrorCode.TIMEOUT, `macOS helper "${op}" timed out`);
    const text = (r.stdout || '').trim();
    let res;
    try {
      res = JSON.parse(text);
    } catch {
      const msg = (r.stderr || text).trim();
      if (/assistive|not allowed|1002|-1719|-25211/i.test(msg)) throw new ToolError(ErrorCode.PERMISSION_DENIED, `macOS denied automation: ${msg}`, { hint: PERMISSION_HINT });
      throw new ToolError(ErrorCode.BACKEND_FAILED, `macOS helper "${op}" failed: ${msg.slice(0, 400)}`);
    }
    if (!res.ok) {
      if (res.error === 'permission') throw new ToolError(ErrorCode.PERMISSION_DENIED, `macOS denied automation: ${res.message}`, { hint: PERMISSION_HINT });
      const notFound = /not found|no process|no longer|can't get|invalid index/i.test(res.message || '');
      throw new ToolError(notFound ? ErrorCode.NOT_FOUND : ErrorCode.BACKEND_FAILED, `${op}: ${res.message}`);
    }
    return res;
  }

  async capabilities() {
    return {
      screenshot: { available: !!which('screencapture'), method: 'screencapture', hint: 'Requires Screen Recording permission for the host app.' },
      input: { available: true, method: which('cliclick') ? 'coregraphics+cliclick' : 'coregraphics', hint: 'Requires Accessibility permission for the host app.' },
      windows: { available: true, method: 'coregraphics+system-events' },
      clipboard: { available: !!which('pbcopy'), method: 'pbcopy/pbpaste' },
      accessibility: { available: true, method: 'system-events (AXUIElement)' },
      ocr_native: { available: true, method: 'vision-framework' },
      launch: { available: true, method: 'open' },
    };
  }

  async screens() {
    return (await this.helper('screens')).screens;
  }

  async capture() {
    await fsp.mkdir(this.paths.tmp, { recursive: true });
    const file = path.join(this.paths.tmp, `cap-${process.pid}-${Date.now()}.png`);
    const r = await run('screencapture', ['-x', '-C', '-t', 'png', file], { timeoutMs: 20000 });
    if (r.code !== 0) throw new ToolError(ErrorCode.BACKEND_FAILED, `screencapture failed: ${r.stderr.trim()}`, { hint: PERMISSION_HINT });
    const png = await fsp.readFile(file);
    await fsp.rm(file, { force: true });
    const [main] = await this.screens();
    const { width } = pngSize(png);
    return { png, pixelRatio: main ? width / main.width : 1, method: 'screencapture' };
  }

  async listWindows() {
    return (await this.helper('windows')).windows;
  }

  async windowAction(id, action, opts = {}) {
    const wins = await this.listWindows();
    const w = wins.find((x) => x.id === String(id));
    if (!w) throw new ToolError(ErrorCode.NOT_FOUND, `Window ${id} not found`);
    await this.helper('window_action', { pid: w.pid, title: w.title, x: w.x, y: w.y, action, nx: opts.x ?? w.x, ny: opts.y ?? w.y, nw: opts.width ?? w.width, nh: opts.height ?? w.height });
  }

  async mouseMove(x, y) {
    await this.helper('mouse_move', { x, y });
  }

  async mouseButton(button = 'left', state = 'down') {
    await this.helper('mouse_button', { button, state });
  }

  async click(x, y, { button = 'left', count = 1 } = {}) {
    if (which('cliclick') && x !== undefined && button !== 'middle') {
      const verb = count === 2 ? 'dc' : button === 'right' ? 'rc' : count === 3 ? 'tc' : 'c';
      await runOk('cliclick', [`${verb}:${Math.round(x)},${Math.round(y)}`], { timeoutMs: 5000 });
      return;
    }
    await this.helper('click', { x, y, button, count });
  }

  async scroll({ x, y, dx = 0, dy = 0 }) {
    await this.helper('scroll', { x, y, dx, dy });
  }

  async mousePosition() {
    const r = await this.helper('mouse_pos');
    return { x: r.x, y: r.y };
  }

  async key(combo, { repeat = 1 } = {}) {
    const m = toMacSystemEvents(combo);
    await this.helper('key', { ...m, repeat });
  }

  async keyToggle(combo, state) {
    const k = combo.key;
    const code = { ctrl: 59, alt: 58, shift: 56, meta: 55 }[k] ?? MAC_KEYCODES[k];
    if (code === undefined) throw this.unsupported(`Holding key "${k}"`, 'Only modifiers and named keys can be held on macOS.');
    await this.helper('key_toggle', { keyCode: code, state });
  }

  async typeText(text) {
    // System Events' keystroke is reliable for ASCII. For other text, paste via the clipboard and restore it.
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7e\n\t]*$/.test(text)) {
      for (const [i, line] of text.split('\n').entries()) {
        if (i > 0) await this.helper('key', { keyCode: 36, using: [] });
        if (line) await this.helper('type', { text: line }, { timeoutMs: 30000 + line.length * 50 });
      }
      return;
    }
    const previous = await this.clipboardRead().catch(() => null);
    await this.clipboardWrite(text);
    await this.helper('key', { keystroke: 'v', using: ['command down'] });
    await sleep(150);
    if (previous !== null) await this.clipboardWrite(previous);
  }

  async clipboardRead() {
    return (await run('pbpaste', [], { timeoutMs: 5000 })).stdout;
  }

  async clipboardWrite(text) {
    await runWithInputDetached('pbcopy', [], text);
  }

  async listApps() {
    const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
    const apps = [];
    const seen = new Set();
    for (const dir of dirs) {
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.endsWith('.app')) {
          // One level of nesting, e.g. /Applications/Blender Foundation/Blender.app
          if (!e.startsWith('.') && dir === '/Applications') {
            try {
              const sub = await fsp.readdir(path.join(dir, e));
              for (const s of sub) if (s.endsWith('.app')) apps.push(this._appEntry(path.join(dir, e, s), seen));
            } catch {
              /* not a dir */
            }
          }
          continue;
        }
        apps.push(this._appEntry(path.join(dir, e), seen));
      }
    }
    return apps.filter(Boolean);
  }

  _appEntry(p, seen) {
    const name = path.basename(p, '.app');
    if (seen.has(p)) return null;
    seen.add(p);
    return { name, id: name.toLowerCase().replace(/\s+/g, '-'), path: p, source: 'bundle' };
  }

  async launch(app, { args = [], cwd, env, logFile } = {}) {
    if (app.path && app.path.endsWith('.app')) {
      const openArgs = ['-n', '-a', app.path];
      if (args.length) openArgs.push('--args', ...args);
      await runOk('open', openArgs, { timeoutMs: 20000, cwd, env });
      const pid = await this._waitForPid(app);
      return { pid, argv: ['open', ...openArgs] };
    }
    if (app.command || app.path) {
      const { pid } = await spawnDetached(app.command || app.path, args, { cwd, env, logFile });
      return { pid, argv: [app.command || app.path, ...args] };
    }
    const openArgs = ['-a', app.name];
    if (args.length) openArgs.push('--args', ...args);
    await runOk('open', openArgs, { timeoutMs: 20000 });
    return { pid: await this._waitForPid(app), argv: ['open', ...openArgs] };
  }

  async _waitForPid(app, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const { apps } = await this.helper('running_apps', { name: app.path || app.name });
      const hit = apps.find((a) => (app.path && a.bundlePath === app.path) || a.name.toLowerCase() === String(app.name).toLowerCase()) ?? apps[0];
      if (hit) return hit.pid;
      await sleep(300);
    }
    return undefined;
  }

  async runningApps(name) {
    return (await this.helper('running_apps', { name })).apps;
  }

  async quitApp({ name }) {
    await this.helper('quit_app', { name });
  }

  async openPath(target, { reveal = false } = {}) {
    await runOk('open', reveal ? ['-R', target] : [target], { timeoutMs: 15000 });
    return {};
  }

  async a11yTree({ pid, windowTitle, includeMenus }, { depth = 8, maxNodes = 400 } = {}) {
    if (!pid) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'macOS accessibility inspection needs an application (pid)');
    const res = await this.helper('ax_tree', { pid, windowTitle, depth, maxNodes, includeMenus }, { timeoutMs: 60000 });
    return { nodes: res.nodes.map((n) => toNode(n, pid)), truncated: res.truncated };
  }

  async a11yFind({ pid }, { name, role, limit = 20 }) {
    const res = await this.helper('ax_find', { pid, name, role, limit }, { timeoutMs: 60000 });
    return res.nodes.map((n) => toNode(n, pid));
  }

  async a11yAction(ref, action, value) {
    return this.helper('ax_action', { pid: ref.pid, path: ref.path, action, value });
  }

  async menuSelect({ pid }, menuPath) {
    await this.helper('menu_select', { pid, path: menuPath });
    return { method: 'system-events-menubar' };
  }

  async ocrNative(file) {
    const { width, height } = pngSize(await fsp.readFile(file));
    const res = await this.helper('ocr', { path: file }, { timeoutMs: 60000 });
    return res.lines.map((l) => ({
      text: l.text,
      confidence: Math.round(l.confidence * 100),
      x: Math.round(l.nx * width),
      y: Math.round((1 - l.ny - l.nh) * height),
      width: Math.round(l.nw * width),
      height: Math.round(l.nh * height),
    }));
  }
}

function toNode(n, pid) {
  const node = { role: n.role, name: n.name, ref: { kind: 'ax', pid, path: n.path } };
  for (const k of ['description', 'value', 'x', 'y', 'width', 'height', 'enabled', 'focused', 'actions', 'childCount']) if (n[k] !== undefined && n[k] !== '') node[k] = n[k];
  if (n.children) node.children = n.children.map((c) => toNode(c, pid));
  return node;
}
