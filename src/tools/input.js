import { defineTool } from './registry.js';
import { WINDOW_PROPS, windowSelector, assessment, uiTargetRisk, blockedAppRisk } from './common.js';
import { resolveWindow, hasSelector, brief } from '../apps/windows.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { parseCombo, comboToString } from '../core/keys.js';
import { classifyCommand, classifyHotkey, isTerminalWindow, maxRisk } from '../safety/classifier.js';
import { ElementRegistry } from '../ui/elements.js';
import { sleep } from '../core/util.js';

/**
 * Resolve where a pointer action should happen. Priority:
 * element id → text (found via ui_find) → screenshot-relative coords → absolute coords.
 */
async function resolvePoint(rt, a, { prefix = '' } = {}) {
  const el = a[`${prefix}element`];
  const text = a[`${prefix}text`];
  const x = a[`${prefix}x`];
  const y = a[`${prefix}y`];
  if (el) {
    const rec = rt.ui.elements.get(el);
    const c = ElementRegistry.center(rec);
    if (!c) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Element ${el} has no screen position`);
    return { ...c, via: `element ${el}${rec.name ? ` "${rec.name}"` : ''}` };
  }
  if (text) {
    const r = await rt.ui.find({ text, role: prefix ? undefined : a.role, selector: windowSelector(a), limit: 3 });
    const m = r.matches[0];
    if (!m) throw new ToolError(ErrorCode.NOT_FOUND, `Could not find "${text}" on screen`, { hint: r.hint });
    return { ...m.center, via: `text "${m.text}" (${m.source}, score ${m.score})` };
  }
  if (x !== undefined && y !== undefined) {
    if (a.screenshot_id) {
      const p = rt.screen.toScreen(a.screenshot_id, x, y);
      return { ...p, via: `screenshot ${a.screenshot_id} (${x},${y})` };
    }
    return { x: Math.round(x), y: Math.round(y), via: 'coordinates' };
  }
  return null;
}

export const inputMouse = defineTool({
  name: 'input_mouse',
  title: 'Mouse',
  description:
    'Move, click, drag and scroll. Target with `element` (id from ui_find/ui_inspect), `text` (label found via accessibility/OCR — robust to layout changes), ' +
    'or x/y screen coordinates (add `screenshot_id` to give coordinates in that screenshot\'s image space). Actions: move, click, double_click, right_click, middle_click, ' +
    'down, up, drag (to to_x/to_y, to_element or to_text), scroll (dy>0 scrolls down, dx>0 right; or direction+amount), position. ' +
    '`modifiers` (e.g. ["shift"]) are held during the click. Verify the effect afterwards (screenshot/verify).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'drag', 'scroll', 'position'] },
      x: { type: 'number' },
      y: { type: 'number' },
      screenshot_id: { type: 'string', description: 'Interpret x/y (and to_x/to_y) in this screenshot\'s image coordinates.' },
      element: { type: 'string' },
      text: { type: 'string' },
      role: { type: 'string' },
      ...WINDOW_PROPS,
      to_x: { type: 'number' },
      to_y: { type: 'number' },
      to_element: { type: 'string' },
      to_text: { type: 'string' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Keys held during the click, e.g. ["ctrl"] or ["shift"].' },
      dx: { type: 'integer', minimum: -100, maximum: 100 },
      dy: { type: 'integer', minimum: -100, maximum: 100 },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', minimum: 1, maximum: 100, description: 'scroll: number of wheel steps (default 3).' },
      duration_ms: { type: 'integer', minimum: 0, maximum: 10000, description: 'drag: duration.' },
      focus_window: { type: 'boolean', description: 'Focus the selected window first (default true when a window selector is given).' },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    if (a.action === 'position') return assessment('safe');
    const blocked = await blockedAppRisk(rt, { selector: windowSelector(a) });
    if (blocked) return blocked;
    if (a.action === 'move' || a.action === 'scroll') return assessment('low');
    return uiTargetRisk(rt, { text: a.text ?? a.to_text, element: a.element ?? a.to_element });
  },
  summary: (a) => `${a.action}${a.text ? ` "${a.text}"` : a.element ? ` ${a.element}` : a.x !== undefined ? ` at ${a.x},${a.y}${a.screenshot_id ? ` (in ${a.screenshot_id})` : ''}` : ''}`,
  async handler(a, rt) {
    const input = rt.input;
    if (a.action === 'position') return { position: await rt.backend.mousePosition() };
    const sel = windowSelector(a);
    if (hasSelector(sel) && a.focus_window !== false) {
      const w = await resolveWindow(rt.backend, sel);
      if (!w.focused) {
        await rt.backend.windowAction(w.id, 'focus').catch(() => {});
        await sleep(150);
      }
    }
    const p = await resolvePoint(rt, a);
    const res = { action: a.action };
    if (p) res.at = { x: p.x, y: p.y, via: p.via };
    switch (a.action) {
      case 'move':
        if (!p) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'move needs a target');
        await input.move(p);
        break;
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'middle_click': {
        const button = a.action === 'right_click' ? 'right' : a.action === 'middle_click' ? 'middle' : a.button ?? 'left';
        const count = a.action === 'double_click' ? 2 : 1;
        if (!p) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `${a.action} needs a target (element, text, or x/y)`);
        await input.click({ x: p.x, y: p.y, button, count, modifiers: a.modifiers ?? [] });
        break;
      }
      case 'down':
      case 'up':
        await input.mouseButton({ button: a.button ?? 'left', state: a.action, x: p?.x, y: p?.y });
        break;
      case 'drag': {
        if (!p) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'drag needs a start (element, text or x/y)');
        const to = await resolvePoint(rt, a, { prefix: 'to_' }).then((q) => q ?? (a.to_x !== undefined && a.screenshot_id ? rt.screen.toScreen(a.screenshot_id, a.to_x, a.to_y) : null));
        if (!to) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'drag needs a destination (to_element, to_text or to_x/to_y)');
        await input.drag({ from: p, to, button: a.button ?? 'left', durationMs: a.duration_ms ?? 300 });
        res.to = { x: to.x, y: to.y, via: to.via };
        break;
      }
      case 'scroll': {
        let { dx = 0, dy = 0 } = a;
        if (a.direction) {
          const n = a.amount ?? 3;
          dx = a.direction === 'left' ? -n : a.direction === 'right' ? n : 0;
          dy = a.direction === 'up' ? -n : a.direction === 'down' ? n : 0;
        }
        if (!dx && !dy) dy = 3;
        await input.scroll({ x: p?.x, y: p?.y, dx, dy });
        res.scrolled = { dx, dy };
        break;
      }
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
    return res;
  },
});

export const inputKeyboard = defineTool({
  name: 'input_keyboard',
  title: 'Keyboard',
  description:
    'Type text or press keys in the focused window (or focus a window first via the selector). Actions: "type" (text; method "paste" uses the clipboard — fast and exact for long/unicode text), ' +
    '"press" (a key or combo: "enter", "ctrl+s", "mod+shift+p", ["alt","f4"]; `mod` = Cmd on macOS, Ctrl elsewhere; `repeat` presses N times), "hold"/"release" (keep a key down). ' +
    'Prefer app shortcuts and terminal_run over typing commands into terminals. Typing into a terminal window is risk-classified as a command.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['type', 'press', 'hold', 'release'] },
      text: { type: 'string', description: 'type: the text ("\\n" presses Enter).' },
      keys: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'press/hold/release: e.g. "mod+s" or ["ctrl","shift","t"].' },
      repeat: { type: 'integer', minimum: 1, maximum: 100 },
      method: { type: 'string', enum: ['auto', 'keys', 'paste'] },
      delay_ms: { type: 'integer', minimum: 0, maximum: 1000, description: 'type: delay between keystrokes.' },
      ...WINDOW_PROPS,
    },
    required: ['action'],
  },
  async assess(a, rt) {
    const blocked = await blockedAppRisk(rt, { selector: windowSelector(a) });
    if (blocked) return blocked;
    if (a.action === 'press' || a.action === 'hold') {
      const combo = comboToString(parseCombo(a.keys ?? ''));
      return classifyHotkey(combo);
    }
    if (a.action === 'type') {
      let win = null;
      try {
        win = await resolveWindow(rt.backend, hasSelector(windowSelector(a)) ? windowSelector(a) : null, { required: false });
      } catch {
        /* ignore */
      }
      if (isTerminalWindow(win)) {
        const c = classifyCommand(a.text ?? '', rt.policy.classifierOptions());
        c.reasons.push('typing into a terminal window executes commands');
        return { ...c, risk: maxRisk(c.risk, 'low') };
      }
    }
    return assessment('low');
  },
  summary: (a) => (a.action === 'type' ? `type "${String(a.text ?? '').slice(0, 80)}"` : `${a.action} ${Array.isArray(a.keys) ? a.keys.join('+') : a.keys}`),
  async handler(a, rt) {
    const sel = windowSelector(a);
    let win = null;
    if (hasSelector(sel)) {
      win = await resolveWindow(rt.backend, sel);
      if (!win.focused) {
        await rt.backend.windowAction(win.id, 'focus').catch(() => {});
        await sleep(150);
        const now = await rt.backend.activeWindow().catch(() => null);
        if (now && now.id !== win.id) {
          throw new ToolError(ErrorCode.BACKEND_FAILED, `Could not focus "${win.title}" (focus is on "${now.title}")`, {
            hint: 'Click inside the window first, or restore it if minimized. Keystrokes would go to the wrong window.',
          });
        }
      }
    } else {
      win = await rt.backend.activeWindow().catch(() => null);
    }
    const res = { action: a.action, window: brief(win) };
    switch (a.action) {
      case 'type': {
        if (typeof a.text !== 'string') throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'type needs text');
        res.method = await rt.input.type(a.text, { method: a.method ?? 'auto', delayMs: a.delay_ms, activeWindow: win });
        res.chars = a.text.length;
        break;
      }
      case 'press': {
        const combo = parseCombo(a.keys ?? '');
        await rt.input.key(combo, { repeat: a.repeat ?? 1 });
        res.keys = comboToString(combo);
        break;
      }
      case 'hold':
      case 'release': {
        const combo = parseCombo(a.keys ?? '');
        if (combo.modifiers.length) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'hold/release take a single key');
        await rt.input.keyToggle(combo, a.action === 'hold' ? 'down' : 'up');
        res.keys = combo.key;
        break;
      }
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
    return res;
  },
});

export const clipboardTool = defineTool({
  name: 'clipboard',
  title: 'Clipboard',
  description: 'Read or write the system clipboard text. Useful for moving text in/out of apps exactly (copy with mod+c then read).',
  inputSchema: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } },
    required: ['action'],
  },
  assess: (a) => (a.action === 'read' ? assessment('low', ['the clipboard may contain sensitive data']) : assessment('low')),
  async handler(a, rt) {
    if (a.action === 'read') {
      const text = await rt.backend.clipboardRead();
      return { text: text.length > 20000 ? text.slice(0, 20000) + '…' : text, length: text.length };
    }
    if (typeof a.text !== 'string') throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'write needs text');
    await rt.backend.clipboardWrite(a.text);
    return { written: a.text.length };
  },
});
