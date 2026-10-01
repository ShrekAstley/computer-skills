import path from 'node:path';
import fsp from 'node:fs/promises';
import { Backend } from './base.js';
import { run, runOk, which, spawnDetached, runWithInputDetached } from '../core/exec.js';
import { ToolError, ErrorCode, missingDependency } from '../core/errors.js';
import { toXdotool, toWtypeArgs } from '../core/keys.js';
import { decodeXwd, encodePng, isPng } from '../screen/png.js';
import { listDesktopApps, parseExec, parseWmctrl, parseSwayTree, parseHyprClients, normalizeXid, parseXwininfoTree } from './linux-desktop.js';
import { PACKAGE_ROOT } from '../core/paths.js';

const ATSPI_SCRIPT = path.join(PACKAGE_ROOT, 'src', 'platform', 'helpers', 'linux_atspi.py');
const BUTTONS = { left: 1, middle: 2, right: 3, back: 8, forward: 9 };

/**
 * Linux backend. X11 is driven with xdotool/wmctrl (the most capable path);
 * Wayland sessions use compositor IPC (sway, Hyprland) for windows, grim /
 * gnome-screenshot / spectacle for capture, and ydotool / wtype for input.
 * Accessibility goes through AT-SPI (python3-gi), OCR through tesseract.
 */
export class LinuxBackend extends Backend {
  constructor(opts) {
    super(opts);
    const env = process.env;
    this.session = env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland' ? 'wayland' : env.DISPLAY ? 'x11' : 'none';
    this.hasX = !!env.DISPLAY;
    this.compositor = env.SWAYSOCK ? 'sway' : env.HYPRLAND_INSTANCE_SIGNATURE ? 'hyprland' : null;
    this.desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || null;
    this._python = undefined;
  }

  get name() {
    return `linux-${this.session}`;
  }

  info() {
    return { os: 'linux', session: this.session, display: process.env.DISPLAY || null, wayland: process.env.WAYLAND_DISPLAY || null, compositor: this.compositor, desktop: this.desktop };
  }

  // ------------------------------------------------------------ capabilities
  _x(tool) {
    return this.hasX ? which(tool) : null;
  }

  async capabilities() {
    const t = (n) => which(n);
    const screenshot = this.session === 'wayland'
      ? t('grim') ? 'grim' : t('gnome-screenshot') ? 'gnome-screenshot' : t('spectacle') ? 'spectacle' : this._x('import') ? 'import (XWayland only)' : null
      : this._x('import') ? 'imagemagick-import' : this._x('maim') ? 'maim' : this._x('scrot') ? 'scrot' : this._x('xwd') ? 'xwd' : null;
    const input = this.session === 'x11' && t('xdotool') ? 'xdotool'
      : t('ydotool') ? 'ydotool' + (t('wtype') ? '+wtype' : '')
      : t('wtype') ? 'wtype (keyboard only)'
      : this._x('xdotool') ? 'xdotool (XWayland windows only)' : null;
    const windows = this.compositor === 'sway' && t('swaymsg') ? 'swaymsg'
      : this.compositor === 'hyprland' && t('hyprctl') ? 'hyprctl'
      : this._x('wmctrl') ? 'wmctrl' + (this._x('xdotool') ? '+xdotool' : '')
      : this._x('xdotool') ? 'xdotool' : null;
    const clipboard = this.session === 'wayland' && t('wl-copy') ? 'wl-clipboard' : this._x('xclip') ? 'xclip' : this._x('xsel') ? 'xsel' : null;
    const a11y = (await this._atspiPython()) ? 'at-spi' : null;
    const hints = {
      screenshot: this.session === 'wayland' ? 'Install grim (wlroots) or gnome-screenshot / spectacle.' : 'Install imagemagick, maim, scrot or x11-apps (xwd).',
      input: this.session === 'wayland' ? 'Install ydotool (and run ydotoold) and/or wtype. GNOME/KDE Wayland need ydotool.' : 'Install xdotool.',
      windows: this.session === 'wayland' ? 'Window control on Wayland requires sway (swaymsg) or Hyprland (hyprctl); other compositors expose no API.' : 'Install wmctrl and xdotool.',
      clipboard: this.session === 'wayland' ? 'Install wl-clipboard.' : 'Install xclip or xsel.',
      a11y: 'Install python3-gi and gir1.2-atspi-2.0 (at-spi2-core). Qt apps may need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1.',
    };
    const cap = (method, key) => ({ available: !!method, method: method ?? undefined, hint: method ? undefined : hints[key] });
    return {
      screenshot: cap(screenshot, 'screenshot'),
      input: cap(input, 'input'),
      windows: cap(windows, 'windows'),
      clipboard: cap(clipboard, 'clipboard'),
      accessibility: cap(a11y, 'a11y'),
      launch: { available: true, method: 'desktop-entry/exec' },
    };
  }

  _need(tool, hint) {
    const p = which(tool);
    if (!p) throw missingDependency(tool, hint);
    return p;
  }

  _xdotool() {
    if (!this.hasX) throw new ToolError(ErrorCode.UNSUPPORTED, 'No X display available (DISPLAY is not set)', { hint: this.session === 'wayland' ? 'On Wayland install ydotool/wtype for input.' : 'Run inside a graphical session.' });
    return this._need('xdotool', 'Install xdotool (e.g. sudo apt install xdotool).');
  }

  // ------------------------------------------------------------------ screen
  async screens() {
    if (this.hasX && which('xrandr')) {
      const r = await run('xrandr', ['--listmonitors'], { timeoutMs: 5000 });
      const mons = [];
      for (const line of r.stdout.split('\n')) {
        // " 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1"
        const m = line.match(/^\s*(\d+):\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/);
        if (m) mons.push({ id: m[3], primary: m[2] === '*', width: +m[4], height: +m[5], x: +m[6], y: +m[7], scale: 1 });
      }
      if (mons.length) return mons;
    }
    if (this.hasX && which('xdotool')) {
      const out = await runOk('xdotool', ['getdisplaygeometry'], { timeoutMs: 5000 });
      const [w, h] = out.trim().split(/\s+/).map(Number);
      return [{ id: 'default', primary: true, x: 0, y: 0, width: w, height: h, scale: 1 }];
    }
    if (this.compositor === 'sway') {
      const outs = JSON.parse(await runOk('swaymsg', ['-t', 'get_outputs', '-r'], { timeoutMs: 5000 }));
      return outs.filter((o) => o.active).map((o) => ({ id: o.name, primary: !!o.focused, x: o.rect.x, y: o.rect.y, width: o.rect.width, height: o.rect.height, scale: o.scale ?? 1 }));
    }
    if (this.compositor === 'hyprland') {
      const mons = JSON.parse(await runOk('hyprctl', ['monitors', '-j'], { timeoutMs: 5000 }));
      return mons.map((m) => ({ id: m.name, primary: !!m.focused, x: m.x, y: m.y, width: Math.round(m.width / (m.scale || 1)), height: Math.round(m.height / (m.scale || 1)), scale: m.scale ?? 1 }));
    }
    return [];
  }

  /** Capture the whole virtual screen as PNG. */
  async capture() {
    const tmp = path.join(this.paths.tmp, `cap-${process.pid}-${Date.now()}.png`);
    await fsp.mkdir(this.paths.tmp, { recursive: true });
    const attempts = [];
    if (this.session === 'wayland') {
      if (which('grim')) attempts.push(['grim', ['-t', 'png', '-']]);
      if (which('gnome-screenshot')) attempts.push(['gnome-screenshot', ['-f', tmp], tmp]);
      if (which('spectacle')) attempts.push(['spectacle', ['-b', '-n', '-f', '-o', tmp], tmp]);
    }
    if (this.hasX) {
      if (which('import')) attempts.push(['import', ['-silent', '-window', 'root', 'png:-']]);
      if (which('maim')) attempts.push(['maim', ['--hidecursor', '-f', 'png']]);
      if (which('scrot')) attempts.push(['scrot', ['-o', '-z', tmp], tmp]);
      if (which('xwd')) attempts.push(['xwd', ['-root', '-silent'], null, 'xwd']);
    }
    if (!attempts.length) {
      throw missingDependency('A screenshot tool', this.session === 'wayland' ? 'Install grim (wlroots compositors) or gnome-screenshot.' : 'Install imagemagick (import), maim, scrot or x11-apps (xwd).');
    }
    const errors = [];
    for (const [cmd, args, file, kind] of attempts) {
      try {
        const r = await run(cmd, args, { encoding: 'buffer', timeoutMs: 20000 });
        if (r.code !== 0) {
          errors.push(`${cmd}: exit ${r.code} ${r.stderr.trim().slice(0, 200)}`);
          continue;
        }
        let buf = file ? await fsp.readFile(file) : r.stdout;
        if (file) await fsp.rm(file, { force: true });
        if (kind === 'xwd') buf = encodePng(decodeXwd(buf), { level: 1 });
        if (!isPng(buf)) {
          errors.push(`${cmd}: did not produce a PNG`);
          continue;
        }
        return { png: buf, pixelRatio: 1, method: cmd };
      } catch (err) {
        errors.push(`${cmd}: ${err.message}`);
      }
    }
    throw new ToolError(ErrorCode.BACKEND_FAILED, `All screenshot methods failed: ${errors.join(' | ')}`);
  }

  // ----------------------------------------------------------------- windows
  async listWindows() {
    if (this.compositor === 'sway' && which('swaymsg')) {
      return parseSwayTree(JSON.parse(await runOk('swaymsg', ['-t', 'get_tree', '-r'], { timeoutMs: 5000 })));
    }
    if (this.compositor === 'hyprland' && which('hyprctl')) {
      return parseHyprClients(JSON.parse(await runOk('hyprctl', ['clients', '-j'], { timeoutMs: 5000 })));
    }
    if (!this.hasX) throw this.unsupported('Window listing', 'This Wayland compositor exposes no window API. Use screenshots + OCR, or run apps under XWayland.');
    let wins;
    if (which('wmctrl')) {
      wins = parseWmctrl(await runOk('wmctrl', ['-lpGx'], { timeoutMs: 5000 }));
      // wmctrl double-counts the frame offset under reparenting window managers;
      // xwininfo reports true absolute client geometry for every window in one call.
      if (which('xwininfo')) {
        const r = await run('xwininfo', ['-root', '-tree'], { timeoutMs: 5000 });
        if (r.code === 0) {
          const geo = parseXwininfoTree(r.stdout);
          for (const w of wins) {
            const g = geo.get(parseInt(w.id, 16));
            if (g) Object.assign(w, g);
          }
        }
      }
    } else if (which('xdotool')) {
      wins = await this._xdotoolWindows();
    } else {
      throw missingDependency('wmctrl/xdotool', 'Install wmctrl and xdotool.');
    }
    const active = await this._activeXid();
    for (const w of wins) w.focused = active !== null && parseInt(w.id, 16) === active;
    return wins;
  }

  async _xdotoolWindows() {
    const r = await run('xdotool', ['search', '--onlyvisible', '--name', '.'], { timeoutMs: 5000 });
    const ids = r.stdout.split('\n').filter(Boolean).slice(0, 200);
    const wins = [];
    for (const id of ids) {
      const g = await run('xdotool', ['getwindowname', id, 'getwindowgeometry', '--shell', id, 'getwindowpid', id], { timeoutMs: 3000 });
      const lines = g.stdout.split('\n');
      const kv = Object.fromEntries(lines.filter((l) => l.includes('=')).map((l) => l.split('=')));
      const pidLine = lines.filter(Boolean).pop();
      wins.push({ id: normalizeXid(Number(id)), title: lines[0] ?? '', app: '', pid: Number(pidLine) || undefined, x: +kv.X || 0, y: +kv.Y || 0, width: +kv.WIDTH || 0, height: +kv.HEIGHT || 0 });
    }
    return wins;
  }

  async _activeXid() {
    if (which('xdotool')) {
      const r = await run('xdotool', ['getactivewindow'], { timeoutMs: 3000 });
      if (r.code === 0 && r.stdout.trim()) return Number(r.stdout.trim());
    }
    if (which('xprop')) {
      const r = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeoutMs: 3000 });
      const m = r.stdout.match(/0x[0-9a-f]+/i);
      if (m) return parseInt(m[0], 16);
    }
    return null;
  }

  async activeWindow() {
    const wins = await this.listWindows();
    return wins.find((w) => w.focused) ?? null;
  }

  async windowAction(id, action, opts = {}) {
    if (this.compositor === 'sway' && which('swaymsg')) return this._swayWindow(id, action, opts);
    if (this.compositor === 'hyprland' && which('hyprctl')) return this._hyprWindow(id, action, opts);
    const xid = normalizeXid(id);
    const wm = which('wmctrl');
    const xdo = which('xdotool');
    const dec = String(parseInt(xid, 16));
    switch (action) {
      case 'focus':
        if (wm) await runOk('wmctrl', ['-i', '-a', xid], { timeoutMs: 5000 });
        if (xdo) await run('xdotool', ['windowactivate', '--sync', dec], { timeoutMs: 3000 });
        if (!wm && !xdo) throw missingDependency('wmctrl/xdotool');
        return;
      case 'minimize':
        if (!xdo) throw missingDependency('xdotool', 'Install xdotool to minimize windows.');
        await runOk('xdotool', ['windowminimize', dec], { timeoutMs: 5000 });
        return;
      case 'maximize':
        if (!wm) throw missingDependency('wmctrl', 'Install wmctrl to maximize windows.');
        await runOk('wmctrl', ['-i', '-r', xid, '-b', 'add,maximized_vert,maximized_horz'], { timeoutMs: 5000 });
        return;
      case 'restore':
        if (wm) {
          await run('wmctrl', ['-i', '-r', xid, '-b', 'remove,maximized_vert,maximized_horz,fullscreen'], { timeoutMs: 5000 });
          await run('wmctrl', ['-i', '-a', xid], { timeoutMs: 5000 });
        } else if (xdo) await runOk('xdotool', ['windowmap', dec, 'windowactivate', dec], { timeoutMs: 5000 });
        return;
      case 'fullscreen':
        if (!wm) throw missingDependency('wmctrl');
        await runOk('wmctrl', ['-i', '-r', xid, '-b', 'toggle,fullscreen'], { timeoutMs: 5000 });
        return;
      case 'close':
        if (wm) await runOk('wmctrl', ['-i', '-c', xid], { timeoutMs: 5000 });
        else if (xdo) await runOk('xdotool', ['windowclose', dec], { timeoutMs: 5000 });
        else throw missingDependency('wmctrl/xdotool');
        return;
      case 'move':
      case 'resize': {
        const { x = -1, y = -1, width = -1, height = -1 } = opts;
        if (wm) {
          await run('wmctrl', ['-i', '-r', xid, '-b', 'remove,maximized_vert,maximized_horz'], { timeoutMs: 5000 });
          await runOk('wmctrl', ['-i', '-r', xid, '-e', `0,${x},${y},${width},${height}`], { timeoutMs: 5000 });
        } else if (xdo) {
          if (action === 'move' || (x >= 0 && y >= 0)) await runOk('xdotool', ['windowmove', '--sync', dec, String(x), String(y)], { timeoutMs: 5000 });
          if (width > 0 && height > 0) await runOk('xdotool', ['windowsize', '--sync', dec, String(width), String(height)], { timeoutMs: 5000 });
        } else throw missingDependency('wmctrl/xdotool');
        return;
      }
      default:
        throw this.unsupported(`Window action "${action}"`);
    }
  }

  async _swayWindow(id, action, opts) {
    const sel = `[con_id=${id}]`;
    const cmds = {
      focus: 'focus',
      close: 'kill',
      fullscreen: 'fullscreen toggle',
      maximize: 'fullscreen enable',
      restore: 'fullscreen disable',
      minimize: 'move scratchpad',
      move: `floating enable, move position ${opts.x ?? 0} ${opts.y ?? 0}`,
      resize: `floating enable, resize set ${opts.width ?? 800} ${opts.height ?? 600}`,
    };
    if (!cmds[action]) throw this.unsupported(`Window action "${action}"`);
    await runOk('swaymsg', [`${sel} ${cmds[action]}`], { timeoutMs: 5000 });
  }

  async _hyprWindow(id, action, opts) {
    const w = `address:${id}`;
    const d = (...a) => runOk('hyprctl', ['dispatch', ...a], { timeoutMs: 5000 });
    switch (action) {
      case 'focus': return d('focuswindow', w);
      case 'close': return d('closewindow', w);
      case 'fullscreen': case 'maximize': await d('focuswindow', w); return d('fullscreen', '1');
      case 'restore': await d('focuswindow', w); return d('fullscreen', '0');
      case 'minimize': return d('movetoworkspacesilent', `special:minimized,${w}`);
      case 'move': return d('movewindowpixel', `exact ${opts.x ?? 0} ${opts.y ?? 0},${w}`);
      case 'resize': return d('resizewindowpixel', `exact ${opts.width ?? 800} ${opts.height ?? 600},${w}`);
      default: throw this.unsupported(`Window action "${action}"`);
    }
  }

  // ------------------------------------------------------------------- input
  _inputTool() {
    if (this.session === 'x11' && which('xdotool')) return 'xdotool';
    if (this.session === 'wayland') {
      if (which('ydotool')) return 'ydotool';
      if (this.hasX && which('xdotool')) return 'xdotool';
    }
    if (this.hasX && which('xdotool')) return 'xdotool';
    throw missingDependency('A mouse/keyboard driver', this.session === 'wayland' ? 'Install ydotool (and start ydotoold) — or wtype for keyboard-only input.' : 'Install xdotool.');
  }

  async mouseMove(x, y) {
    if (this._inputTool() === 'ydotool') {
      await runOk('ydotool', ['mousemove', '--absolute', '-x', String(Math.round(x)), '-y', String(Math.round(y))], { timeoutMs: 5000 });
      return;
    }
    await runOk(this._xdotool(), ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))], { timeoutMs: 5000 });
  }

  async mouseButton(button = 'left', state = 'down') {
    if (this._inputTool() === 'ydotool') {
      const code = { left: 0x00, right: 0x01, middle: 0x02 }[button] ?? 0;
      const flag = state === 'down' ? 0x40 : 0x80;
      await runOk('ydotool', ['click', '0x' + (code | flag).toString(16)], { timeoutMs: 5000 });
      return;
    }
    await runOk(this._xdotool(), [state === 'down' ? 'mousedown' : 'mouseup', String(BUTTONS[button] ?? 1)], { timeoutMs: 5000 });
  }

  async click(x, y, { button = 'left', count = 1 } = {}) {
    if (this._inputTool() === 'ydotool') {
      if (x !== undefined) await this.mouseMove(x, y);
      const code = { left: 0xc0, right: 0xc1, middle: 0xc2 }[button] ?? 0xc0;
      await runOk('ydotool', ['click', '--repeat', String(count), '--next-delay', '80', '0x' + code.toString(16)], { timeoutMs: 5000 });
      return;
    }
    const args = [];
    if (x !== undefined) args.push('mousemove', '--sync', String(Math.round(x)), String(Math.round(y)));
    args.push('click', '--repeat', String(count), '--delay', '80', String(BUTTONS[button] ?? 1));
    await runOk(this._xdotool(), args, { timeoutMs: 5000 });
  }

  async scroll({ x, y, dx = 0, dy = 0 }) {
    if (this._inputTool() === 'ydotool') {
      if (x !== undefined) await this.mouseMove(x, y);
      await runOk('ydotool', ['mousemove', '--wheel', '-x', String(-dx), '-y', String(-dy)], { timeoutMs: 5000 });
      return;
    }
    const args = [];
    if (x !== undefined) args.push('mousemove', '--sync', String(Math.round(x)), String(Math.round(y)));
    // X11 buttons: 4 up, 5 down, 6 left, 7 right. dy > 0 scrolls down.
    if (dy) args.push('click', '--repeat', String(Math.abs(dy)), '--delay', '30', dy > 0 ? '5' : '4');
    if (dx) args.push('click', '--repeat', String(Math.abs(dx)), '--delay', '30', dx > 0 ? '7' : '6');
    if (args.length) await runOk(this._xdotool(), args, { timeoutMs: 10000 });
  }

  async mousePosition() {
    if (!this.hasX || !which('xdotool')) throw this.unsupported('Reading the mouse position', 'Requires xdotool on X11.');
    const out = await runOk('xdotool', ['getmouselocation', '--shell'], { timeoutMs: 3000 });
    const kv = Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
    return { x: Number(kv.X), y: Number(kv.Y) };
  }

  async key(combo, { repeat = 1 } = {}) {
    if (this.session === 'wayland' && !this.hasX && which('wtype')) {
      for (let i = 0; i < repeat; i++) await runOk('wtype', toWtypeArgs(combo), { timeoutMs: 5000 });
      return;
    }
    const k = toXdotool(combo);
    await runOk(this._xdotool(), ['key', '--clearmodifiers', '--repeat', String(repeat), '--delay', '40', k], { timeoutMs: 10000 });
  }

  async keyToggle(combo, state) {
    const k = toXdotool(combo);
    await runOk(this._xdotool(), [state === 'down' ? 'keydown' : 'keyup', k], { timeoutMs: 5000 });
  }

  async typeText(text, { delayMs = 6 } = {}) {
    if (this.session === 'wayland' && !this.hasX) {
      if (which('wtype')) return void (await runOk('wtype', ['-d', String(delayMs), '--', text], { timeoutMs: 120000 }));
      if (which('ydotool')) return void (await runOk('ydotool', ['type', '--key-delay', String(delayMs), '--', text], { timeoutMs: 120000 }));
    }
    // xdotool turns "\n" into Return presses.
    const timeoutMs = 30000 + text.length * (delayMs + 5);
    await runOk(this._xdotool(), ['type', '--clearmodifiers', '--delay', String(delayMs), '--', text], { timeoutMs });
  }

  // --------------------------------------------------------------- clipboard
  async clipboardRead() {
    if (this.session === 'wayland' && which('wl-paste')) return (await run('wl-paste', ['-n'], { timeoutMs: 5000 })).stdout;
    if (this.hasX && which('xclip')) return (await run('xclip', ['-selection', 'clipboard', '-o'], { timeoutMs: 5000 })).stdout;
    if (this.hasX && which('xsel')) return (await run('xsel', ['-b', '-o'], { timeoutMs: 5000 })).stdout;
    throw missingDependency('A clipboard tool', 'Install xclip, xsel or wl-clipboard.');
  }

  async clipboardWrite(text) {
    // xclip/wl-copy fork a server process that owns the selection; don't wait on its stdout.
    if (this.session === 'wayland' && which('wl-copy')) return void (await runWithInputDetached('wl-copy', [], text));
    if (this.hasX && which('xclip')) return void (await runWithInputDetached('xclip', ['-selection', 'clipboard', '-i'], text));
    if (this.hasX && which('xsel')) return void (await runWithInputDetached('xsel', ['-b', '-i'], text));
    throw missingDependency('A clipboard tool', 'Install xclip, xsel or wl-clipboard.');
  }

  // -------------------------------------------------------------------- apps
  async listApps() {
    return listDesktopApps();
  }

  /**
   * @param {{path?: string, exec?: string, command?: string, id?: string, name?: string}} app
   */
  async launch(app, { args = [], cwd, env, logFile } = {}) {
    let argv;
    if (app.exec) argv = parseExec(app.exec);
    else if (app.command) argv = [app.command];
    else if (app.path) argv = [app.path];
    else throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Nothing to launch');
    // `flatpak run` and similar wrappers are fine: we track windows by name/class too.
    const [cmd, ...rest] = argv;
    const { pid } = await spawnDetached(cmd, [...rest, ...args], { cwd, env, logFile });
    return { pid, argv: [cmd, ...rest, ...args] };
  }

  async openPath(target) {
    const opener = which('xdg-open') || which('gio') || which('gnome-open') || which('kde-open');
    if (!opener) throw missingDependency('xdg-open', 'Install xdg-utils.');
    const args = path.basename(opener) === 'gio' ? ['open', target] : [target];
    const { pid } = await spawnDetached(opener, args);
    return { pid };
  }

  // ------------------------------------------------------------ accessibility
  async _atspiPython() {
    if (this._python !== undefined) return this._python;
    this._python = null;
    for (const py of ['/usr/bin/python3', which('python3')].filter(Boolean)) {
      try {
        const r = await run(py, ['-c', "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"], { timeoutMs: 8000 });
        if (r.code === 0) {
          this._python = py;
          break;
        }
      } catch {
        /* next */
      }
    }
    return this._python;
  }

  async _atspi(req) {
    const py = await this._atspiPython();
    if (!py) throw missingDependency('AT-SPI (python3-gi)', 'Install python3-gi and gir1.2-atspi-2.0; ensure the at-spi2 bus is running. Fall back to OCR (screen_text / ui_find method "ocr").');
    const r = await run(py, [ATSPI_SCRIPT], { input: JSON.stringify(req), timeoutMs: 30000 });
    let res;
    try {
      res = JSON.parse(r.stdout || '{}');
    } catch {
      throw new ToolError(ErrorCode.BACKEND_FAILED, `AT-SPI helper returned invalid output: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    if (!res.ok) {
      const code = res.error === 'LookupError' ? ErrorCode.NOT_FOUND : res.error === 'atspi-unavailable' ? ErrorCode.DEPENDENCY_MISSING : ErrorCode.BACKEND_FAILED;
      throw new ToolError(code, `AT-SPI: ${res.message || res.error}`);
    }
    return res;
  }

  async a11yTree({ pid, pids, app, windowTitle }, { depth = 8, maxNodes = 400, onlyVisible = true } = {}) {
    const res = await this._atspi({ op: 'tree', pid, pids, app, windowTitle, depth, maxNodes, onlyVisible });
    return { nodes: res.nodes.map(toNode), truncated: res.truncated };
  }

  async a11yFind({ pid, pids, app }, { name, role, limit = 20 }) {
    const res = await this._atspi({ op: 'find', pid, pids, app, name, role, limit });
    return res.nodes.map(toNode);
  }

  async a11yAction(ref, action, value) {
    return this._atspi({ op: 'action', path: ref.path, action, value });
  }
}

function toNode(n) {
  const node = {
    role: n.role,
    name: n.name,
    ref: { kind: 'atspi', path: n.path },
  };
  if (n.description) node.description = n.description;
  if (n.value !== undefined && n.value !== null && n.value !== '') node.value = n.value;
  if (n.width !== undefined && n.width > 0) Object.assign(node, { x: n.x, y: n.y, width: n.width, height: n.height });
  if (n.states) {
    node.enabled = n.states.includes('enabled') || n.states.includes('sensitive');
    if (n.states.includes('focused')) node.focused = true;
    const flags = n.states.filter((s) => ['checked', 'selected', 'expanded', 'editable'].includes(s));
    if (flags.length) node.states = flags;
  }
  if (n.actions?.length) node.actions = n.actions.filter(Boolean);
  if (n.childCount) node.childCount = n.childCount;
  if (n.children) node.children = n.children.map(toNode);
  return node;
}
