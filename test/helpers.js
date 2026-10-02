import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backend } from '../src/platform/base.js';
import { encodePng } from '../src/screen/png.js';
import { createRuntime } from '../src/index.js';
import { Logger } from '../src/core/logger.js';

export function tmpDir(prefix = 'cs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A scriptable in-memory desktop for unit tests. */
export class FakeBackend extends Backend {
  constructor(opts = {}) {
    super({ config: {}, logger: null, paths: opts.paths ?? { tmp: tmpDir() } });
    this.windows = opts.windows ?? [];
    this.events = [];
    this.mouse = { x: 500, y: 500 };
    this.clipboard = '';
    this.screen = { width: 200, height: 100 };
    this.apps = opts.apps ?? [];
    this.a11y = opts.a11y ?? [];
    this.ocrLines = opts.ocrLines ?? null;
  }
  get name() { return 'fake'; }
  async capabilities() {
    return { screenshot: { available: true }, input: { available: true }, windows: { available: true }, accessibility: { available: this.a11y.length > 0 }, clipboard: { available: true } };
  }
  async screens() { return [{ id: '0', primary: true, x: 0, y: 0, ...this.screen, scale: 1 }]; }
  async capture() {
    const { width, height } = this.screen;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = (i % width) % 256; data[i * 4 + 1] = Math.floor(i / width) % 256; data[i * 4 + 2] = this.events.length % 256; data[i * 4 + 3] = 255;
    }
    return { png: encodePng({ width, height, data }), pixelRatio: 1 };
  }
  async listWindows() { return this.windows.map((w) => ({ ...w })); }
  async windowAction(id, action, opts) {
    this.events.push(['window', id, action, opts]);
    const w = this.windows.find((x) => x.id === id);
    if (!w) throw new Error('no window');
    if (action === 'focus') this.windows.forEach((x) => (x.focused = x.id === id));
    if (action === 'close') this.windows = this.windows.filter((x) => x.id !== id);
    if (action === 'move') Object.assign(w, { x: opts.x, y: opts.y });
  }
  async mouseMove(x, y) { this.mouse = { x, y }; this.events.push(['move', x, y]); }
  async mouseButton(b, s) { this.events.push(['button', b, s]); }
  async click(x, y, o) { if (x !== undefined) this.mouse = { x, y }; this.events.push(['click', x, y, o.button, o.count]); }
  async scroll(o) { this.events.push(['scroll', o.dx, o.dy]); }
  async mousePosition() { return { ...this.mouse }; }
  async key(combo, o) { this.events.push(['key', [...combo.modifiers, combo.key].join('+'), o?.repeat ?? 1]); }
  async keyToggle(combo, state) { this.events.push(['keytoggle', combo.key, state]); }
  async typeText(text) { this.events.push(['type', text]); }
  async clipboardRead() { return this.clipboard; }
  async clipboardWrite(t) { this.clipboard = t; }
  async listApps() { return this.apps; }
  async launch(app, o) {
    this.events.push(['launch', app, o.args]);
    const id = `w${this.windows.length + 1}`;
    if (app.window !== false) this.windows.push({ id, title: app.windowTitle ?? app.name ?? 'App', app: app.name, pid: 4242, x: 0, y: 0, width: 100, height: 80, focused: true });
    return { pid: 4242, argv: [app.path ?? app.name] };
  }
  async a11yTree() { return { nodes: this.a11y, truncated: false }; }
  async a11yFind(t, { name, role }) {
    const flat = [];
    const walk = (n) => { flat.push(n); (n.children || []).forEach(walk); };
    this.a11y.forEach(walk);
    return flat.filter((n) => (!name || (n.name || '').toLowerCase().includes(name.toLowerCase())) && (!role || (n.role || '').toLowerCase().includes(role.toLowerCase())));
  }
  async a11yAction(ref, action, value) { this.events.push(['a11y', ref.id, action, value]); return { performed: action }; }
  async ocrNative() { return this.ocrLines; }
}

/** Runtime wired to a FakeBackend and a throwaway state directory. */
export async function fakeRuntime({ level = 'normal', backend, env = {}, config } = {}) {
  const home = tmpDir('cs-home-');
  const project = tmpDir('cs-proj-');
  const e = { ...process.env, COMPUTER_SKILLS_HOME: home, COMPUTER_SKILLS_PROJECT_DIR: project, COMPUTER_SKILLS_LEVEL: level, ...env };
  const rt = await createRuntime({ env: e, backend: backend ?? new FakeBackend(), logger: new Logger({ level: 'silent', stderr: false }), builtinWorkflows: false, config });
  rt.config.safety.failsafeCorner = false;
  rt.config.input.postActionDelayMs = 0;
  return rt;
}

export const call = (rt, name, args, extra = {}) => rt.host.invoke(name, args, { via: 'test', ...extra });
