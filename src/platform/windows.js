import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Backend } from './base.js';
import { runOk, which, spawnDetached } from '../core/exec.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { toWindowsVk } from '../core/keys.js';
import { PACKAGE_ROOT } from '../core/paths.js';

const HELPER = path.join(PACKAGE_ROOT, 'src', 'platform', 'helpers', 'windows_helper.ps1');

/**
 * Windows backend. A single long-lived Windows PowerShell 5.1 process hosts
 * compiled Win32 bindings (SendInput, EnumWindows, SetForegroundWindow),
 * UI Automation and WinRT OCR. Keeping it warm makes each action a few ms
 * instead of the ~400 ms a fresh PowerShell would cost.
 */
export class WindowsBackend extends Backend {
  constructor(opts) {
    super(opts);
    this.proc = null;
    this.ready = null;
    this.queue = new Map();
    this.nextId = 1;
    this.buffer = '';
  }

  get name() {
    return 'windows';
  }

  info() {
    return { os: 'windows', release: os.release() };
  }

  _powershell() {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const builtin = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return which('powershell.exe') || builtin;
  }

  _start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ps = this._powershell();
      const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = child;
      let started = false;
      const startTimer = setTimeout(() => {
        if (!started) reject(new ToolError(ErrorCode.TIMEOUT, 'Windows helper did not start within 30s'));
      }, 30000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let i;
        while ((i = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, i).trim();
          this.buffer = this.buffer.slice(i + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line.replace(/^\uFEFF/, ''));
          } catch {
            this.logger?.debug?.('windows helper noise', { line: line.slice(0, 200) });
            continue;
          }
          if (msg.ready) {
            started = true;
            clearTimeout(startTimer);
            resolve();
            continue;
          }
          const p = this.queue.get(msg.id);
          if (!p) continue;
          this.queue.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result ?? {});
          else p.reject(this._error(p.op, msg));
        }
      });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      child.on('error', (err) => {
        clearTimeout(startTimer);
        reject(new ToolError(ErrorCode.DEPENDENCY_MISSING, `Could not start Windows PowerShell: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(startTimer);
        const err = new ToolError(ErrorCode.BACKEND_FAILED, `Windows helper exited (code ${code}). ${stderr.trim().slice(-800)}`);
        for (const p of this.queue.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.queue.clear();
        this.proc = null;
        this.ready = null; // restart lazily on next call
        if (!started) reject(err);
      });
    });
    return this.ready;
  }

  _error(op, msg) {
    const text = String(msg.message || msg.error || 'failed').replace(/^(NOTFOUND|NOPATTERN):\s*/, '');
    if (msg.error === 'notfound') return new ToolError(ErrorCode.NOT_FOUND, `${op}: ${text}`);
    if (msg.error === 'nopattern') return new ToolError(ErrorCode.UNSUPPORTED, `${op}: ${text}`, { hint: 'Fall back to clicking the element (input_mouse with target ref) or keyboard navigation.' });
    if (msg.error === 'permission') {
      return new ToolError(ErrorCode.PERMISSION_DENIED, `${op}: ${text}`, {
        hint: 'The target window is probably elevated (running as administrator). Windows blocks input from non-elevated processes into elevated windows (UIPI). Run the agent elevated or avoid elevated apps.',
      });
    }
    return new ToolError(ErrorCode.BACKEND_FAILED, `${op}: ${text}`);
  }

  async call(op, args = {}, { timeoutMs = 30000 } = {}) {
    await this._start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue.delete(id);
        reject(new ToolError(ErrorCode.TIMEOUT, `Windows helper "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.queue.set(id, { resolve, reject, timer, op });
      this.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  async capabilities() {
    let uia = false;
    let ps = null;
    try {
      const r = await this.call('ping', {}, { timeoutMs: 30000 });
      uia = r.uia;
      ps = r.ps;
    } catch (err) {
      return { helper: { available: false, hint: err.message } };
    }
    return {
      screenshot: { available: true, method: 'gdi-copyfromscreen' },
      input: { available: true, method: 'sendinput', hint: 'Input cannot reach elevated (admin) windows unless the agent runs elevated.' },
      windows: { available: true, method: 'win32' },
      clipboard: { available: true, method: 'winforms' },
      accessibility: { available: uia, method: uia ? 'ui-automation' : undefined },
      ocr_native: { available: true, method: 'windows.media.ocr' },
      launch: { available: true, method: 'createprocess/shell:AppsFolder' },
      powershell: ps,
    };
  }

  async screens() {
    return (await this.call('screens')).screens;
  }

  async capture() {
    await fsp.mkdir(this.paths.tmp, { recursive: true });
    const file = path.join(this.paths.tmp, `cap-${process.pid}-${Date.now()}.png`);
    const r = await this.call('capture', { path: file }, { timeoutMs: 30000 });
    const png = await fsp.readFile(file);
    await fsp.rm(file, { force: true });
    // Virtual screen may start at negative coordinates (monitor left of primary).
    return { png, pixelRatio: 1, origin: { x: r.x, y: r.y }, method: 'gdi' };
  }

  async listWindows() {
    return (await this.call('windows')).windows;
  }

  async dialogsOf(pid) {
    return (await this.call('dialogs', { pid })).windows;
  }

  async windowAction(id, action, opts = {}) {
    await this.call('window_action', { id, action, x: opts.x, y: opts.y, width: opts.width, height: opts.height });
  }

  async mouseMove(x, y) {
    await this.call('mouse_move', { x: Math.round(x), y: Math.round(y) });
  }

  async mouseButton(button = 'left', state = 'down') {
    await this.call('mouse_button', { button, state });
  }

  async click(x, y, { button = 'left', count = 1 } = {}) {
    await this.call('click', { x: x === undefined ? null : Math.round(x), y: y === undefined ? null : Math.round(y), button, count });
  }

  async scroll({ x, y, dx = 0, dy = 0 }) {
    await this.call('scroll', { x: x === undefined ? null : Math.round(x), y: y === undefined ? null : Math.round(y), dx, dy });
  }

  async mousePosition() {
    return this.call('mouse_pos');
  }

  async key(combo, { repeat = 1 } = {}) {
    const { mods, key, char } = toWindowsVk(combo);
    await this.call('key', { mods, key, char, repeat });
  }

  async keyToggle(combo, state) {
    const { key, char } = toWindowsVk(combo);
    if (key === null) throw this.unsupported(`Holding "${char}"`);
    await this.call('key_toggle', { key, state });
  }

  async typeText(text, { delayMs = 6 } = {}) {
    await this.call('type', { text, delay: delayMs }, { timeoutMs: 30000 + text.length * (delayMs + 5) });
  }

  async clipboardRead() {
    return (await this.call('clipboard_get')).text ?? '';
  }

  async clipboardWrite(text) {
    await this.call('clipboard_set', { text });
  }

  async listApps() {
    const { apps } = await this.call('list_apps', {}, { timeoutMs: 60000 });
    const seen = new Set();
    return apps
      .filter((a) => {
        const k = (a.name || '').toLowerCase() + '|' + (a.path || a.appId || '');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((a) => ({ name: a.name, id: (a.name || '').toLowerCase().replace(/\s+/g, '-'), path: a.path, appId: a.appId, source: a.source }));
  }

  async launch(app, { args = [], cwd, env, logFile } = {}) {
    const exe = app.path || app.command;
    if (exe && !/\.lnk$/i.test(exe)) {
      const { pid } = await spawnDetached(exe, args, { cwd, env, logFile });
      return { pid, argv: [exe, ...args] };
    }
    if (app.appId) {
      await this.call('launch_appid', { appId: app.appId });
      return { pid: undefined, argv: [`shell:AppsFolder\\${app.appId}`] };
    }
    if (exe) {
      await runOk('cmd.exe', ['/d', '/s', '/c', 'start', '""', exe, ...args], { timeoutMs: 15000, cwd });
      return { pid: undefined, argv: [exe, ...args] };
    }
    throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Nothing to launch');
  }

  async openPath(target, { reveal = false } = {}) {
    if (reveal) await spawnDetached('explorer.exe', [`/select,${target}`]);
    else await runOk('cmd.exe', ['/d', '/s', '/c', 'start', '""', target], { timeoutMs: 15000 });
    return {};
  }

  async _hwndFor({ windowId, pid, app }) {
    if (windowId) return windowId;
    const wins = await this.listWindows();
    const w = (pid && wins.find((x) => x.pid === pid)) || (app && wins.find((x) => `${x.app} ${x.title}`.toLowerCase().includes(String(app).toLowerCase()))) || wins.find((x) => x.focused);
    if (!w) throw new ToolError(ErrorCode.NOT_FOUND, 'No matching window for accessibility inspection');
    return w.id;
  }

  async a11yTree(target, { depth = 8, maxNodes = 400 } = {}) {
    const hwnd = await this._hwndFor(target);
    const res = await this.call('uia_tree', { hwnd, depth, maxNodes }, { timeoutMs: 60000 });
    return { nodes: res.nodes, truncated: res.truncated };
  }

  async a11yFind(target, { name, role, limit = 20 }) {
    const hwnd = await this._hwndFor(target);
    return (await this.call('uia_find', { hwnd, name, role, limit }, { timeoutMs: 60000 })).nodes;
  }

  async a11yAction(ref, action, value) {
    return this.call('uia_action', { hwnd: ref.hwnd, runtimeId: ref.runtimeId, action, value });
  }

  async menuSelect(target, menuPath) {
    const hwnd = await this._hwndFor(target);
    return this.call('menu_select', { hwnd, path: menuPath }, { timeoutMs: 30000 });
  }

  async ocrNative(file) {
    const { lines } = await this.call('ocr', { path: file }, { timeoutMs: 60000 });
    return lines.map((l) => {
      const xs = l.words.map((w) => w.x), ys = l.words.map((w) => w.y);
      const x2 = l.words.map((w) => w.x + w.width), y2 = l.words.map((w) => w.y + w.height);
      return {
        text: l.text,
        confidence: 90,
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...x2) - Math.min(...xs),
        height: Math.max(...y2) - Math.min(...ys),
        words: l.words,
      };
    });
  }
}
