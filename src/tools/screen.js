import { defineTool } from './registry.js';
import { WINDOW_PROPS, REGION, windowSelector, imageResult, assessment, uiTargetRisk, blockedAppRisk } from './common.js';
import { resolveWindow, hasSelector, brief } from '../apps/windows.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { classifyUiTarget, maxRisk, isProtectedPath } from '../safety/classifier.js';
import fs from 'node:fs';
import path from 'node:path';
import { expandPath } from '../core/paths.js';
import { need } from './terminal.js';

export const screenCapture = defineTool({
  name: 'screen_capture',
  title: 'Screenshot',
  description:
    'Capture the screen, a window (by selector) or a region and return the image plus a screenshot_id. ' +
    'Images are downscaled to max_width (default 1568px) — the result explains how image pixels map to screen coordinates, ' +
    'or pass screenshot_id with image coordinates to input_mouse and it converts for you. Use this to observe state before and after actions.',
  inputSchema: {
    type: 'object',
    properties: {
      ...WINDOW_PROPS,
      region: REGION,
      max_width: { type: 'integer', minimum: 200, maximum: 4000 },
      include_image: { type: 'boolean', description: 'Return the image (default true). false = only save to disk and return metadata.' },
      screens: { type: 'boolean', description: 'Also return monitor layout.' },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    const sel = windowSelector(a);
    const win = hasSelector(sel) ? await resolveWindow(rt.backend, sel) : null;
    if (win?.minimized) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Window "${win.title}" is minimized`, { hint: 'Restore it first (window action "restore").' });
    const { meta, png } = await rt.screen.capture({ region: a.region, window: win, maxWidth: a.max_width });
    const res = imageResult(meta, png, a.include_image !== false);
    if (win) res.window = brief(win);
    if (a.screens) res.screens = await rt.backend.screens().catch(() => undefined);
    return res;
  },
});

export const screenText = defineTool({
  name: 'screen_text',
  title: 'Read text on screen (OCR)',
  description:
    'Extract visible text from the screen, a window or a region with OCR (Vision on macOS, Windows.Media.Ocr on Windows, tesseract anywhere). ' +
    'Returns lines with screen-coordinate bounding boxes (and words), so you can locate labels to click. Works for apps without accessibility support.',
  inputSchema: {
    type: 'object',
    properties: {
      ...WINDOW_PROPS,
      region: REGION,
      min_confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'Drop lines below this OCR confidence (default 30).' },
      words: { type: 'boolean', description: 'Include per-word boxes (default false).' },
      contains: { type: 'string', description: 'Only return lines containing this text (case-insensitive).' },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    const sel = windowSelector(a);
    const win = hasSelector(sel) ? await resolveWindow(rt.backend, sel) : null;
    const r = await rt.ocr.read({ region: a.region, window: win, minConfidence: a.min_confidence ?? 30 });
    let lines = r.lines;
    if (a.contains) lines = lines.filter((l) => l.text.toLowerCase().includes(a.contains.toLowerCase()));
    return {
      engine: r.engine,
      region: r.region,
      window: brief(win),
      line_count: lines.length,
      lines: lines.map((l) => ({ text: l.text, bounds: [l.x, l.y, l.width, l.height], confidence: l.confidence, ...(a.words ? { words: l.words.map((w) => ({ text: w.text, bounds: [w.x, w.y, w.width, w.height] })) } : {}) })),
    };
  },
});

export const uiInspect = defineTool({
  name: 'ui_inspect',
  title: 'Inspect UI (accessibility tree)',
  description:
    'Read a window\'s accessibility tree (UI Automation on Windows, AX on macOS, AT-SPI on Linux): roles, names, values, bounds, available actions, ' +
    'each with an element id ("el-…") usable by ui_action / input_mouse. format="flat" with interactive_only=true gives a compact list of controls. ' +
    'Apps that draw their own UI (Blender, games, some Electron/Java apps) expose little or nothing — then use screen_capture + screen_text.',
  inputSchema: {
    type: 'object',
    properties: {
      ...WINDOW_PROPS,
      depth: { type: 'integer', minimum: 1, maximum: 30, description: 'Max tree depth (default 8).' },
      max_nodes: { type: 'integer', minimum: 10, maximum: 3000, description: 'Node budget (default 300).' },
      format: { type: 'string', enum: ['tree', 'flat'] },
      interactive_only: { type: 'boolean', description: 'flat: only buttons, fields, menu items, etc.' },
      include_menus: { type: 'boolean', description: 'macOS: include the menu bar.' },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    return rt.ui.inspect({ selector: windowSelector(a), depth: a.depth, maxNodes: a.max_nodes, format: a.format, interactiveOnly: a.interactive_only, includeMenus: a.include_menus });
  },
});

export const uiFind = defineTool({
  name: 'ui_find',
  title: 'Find UI elements',
  description:
    'Locate controls or text by visible label (and/or role) in a window or on screen. method "auto" tries the accessibility tree first and falls back to OCR; ' +
    'force one with "a11y" or "ocr". Returns ranked matches with element id, bounds, center point and score. Use the element id with ui_action or input_mouse.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Visible label/text to look for (fuzzy).' },
      role: { type: 'string', description: 'Role filter, e.g. button, menu item, edit, checkbox, tab.' },
      ...WINDOW_PROPS,
      region: REGION,
      method: { type: 'string', enum: ['auto', 'a11y', 'ocr'] },
      exact: { type: 'boolean', description: 'Require an exact (case-insensitive) text match.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    return rt.ui.find({ text: a.text, role: a.role, selector: windowSelector(a), method: a.method ?? 'auto', exact: a.exact, limit: a.limit ?? 8, region: a.region });
  },
});

export const uiAction = defineTool({
  name: 'ui_action',
  title: 'Act on a UI element',
  description:
    'Perform a semantic action on an element: press/click, double_click, focus, set_value (text fields, sliders), toggle, expand, collapse, select. ' +
    'Target it by `element` id (from ui_find/ui_inspect) or by `text` (+ optional role and window selector; the best match is used). ' +
    'Uses accessibility actions when possible (works even if the control is covered) and falls back to clicking its center.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['press', 'click', 'double_click', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select'] },
      element: { type: 'string', description: 'Element id from ui_find / ui_inspect.' },
      text: { type: 'string', description: 'Find the element by label instead of id.' },
      role: { type: 'string' },
      ...WINDOW_PROPS,
      value: { type: ['string', 'number', 'boolean'], description: 'set_value: the new value.' },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    const blocked = await blockedAppRisk(rt, { selector: windowSelector(a) });
    if (blocked) return blocked;
    return uiTargetRisk(rt, { text: a.text, element: a.element });
  },
  summary: (a) => `${a.action} "${a.text ?? a.element}"${a.value !== undefined ? ` = ${String(a.value).slice(0, 60)}` : ''}`,
  async handler(a, rt) {
    let element = a.element;
    let found;
    if (!element) {
      if (!a.text) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Provide element or text');
      const r = await rt.ui.find({ text: a.text, role: a.role, selector: windowSelector(a), limit: 3 });
      found = r.matches[0];
      if (!found) throw new ToolError(ErrorCode.NOT_FOUND, `No element matching "${a.text}"`, { hint: r.hint });
      element = found.el;
    }
    const res = await rt.ui.act({ element, action: a.action, value: a.value });
    if (found) res.matched = { text: found.text, source: found.source, score: found.score };
    return res;
  },
});

export const uiMenu = defineTool({
  name: 'ui_menu',
  title: 'Select a menu item',
  description:
    'Open a menu path in an application, e.g. ["File", "Export", "PNG"]. Uses the native menu API (macOS menu bar, Windows UI Automation) when available, ' +
    'otherwise navigates visually (finds each label with accessibility/OCR and clicks it). Labels match fuzzily and ignore "..." suffixes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'array', items: { type: 'string' }, description: 'Menu labels from the menu bar to the item.' },
      ...WINDOW_PROPS,
      method: { type: 'string', enum: ['auto', 'native', 'visual'] },
      delay_ms: { type: 'integer', minimum: 0, maximum: 5000, description: 'visual: wait after each click (default 350).' },
    },
    required: ['path'],
  },
  async assess(a, rt) {
    const blocked = await blockedAppRisk(rt, { selector: windowSelector(a) });
    if (blocked) return blocked;
    return classifyUiTarget(a.path?.[a.path.length - 1]);
  },
  summary: (a) => `menu ${a.path?.join(' > ')}`,
  async handler(a, rt) {
    return rt.ui.menu({ selector: windowSelector(a), path: a.path, method: a.method ?? 'auto', delayMs: a.delay_ms });
  },
});

export const uiDialog = defineTool({
  name: 'ui_dialog',
  title: 'Handle dialogs',
  description:
    'Deal with dialogs, message boxes and file pickers. Actions: "detect" (list open dialogs), "read" (dialog text via OCR + its buttons), ' +
    '"accept" (press the affirmative button: Save/OK/Open/Yes… or Enter), "cancel" (Cancel/No/Close or Escape), "press" (a specific `button` label), ' +
    '"fill_path" (type `path` into a native Open/Save dialog using the OS\'s reliable keyboard method, then submit). ' +
    'Without a selector, the most likely dialog (focused/newest) is used. Read a dialog before accepting it.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['detect', 'read', 'accept', 'cancel', 'press', 'fill_path'] },
      ...WINDOW_PROPS,
      button: { type: 'string', description: 'press: button label.' },
      path: { type: 'string', description: 'fill_path: file path to enter.' },
      mode: { type: 'string', enum: ['open', 'save'], description: 'fill_path: dialog kind (auto-detected from the title).' },
      submit: { type: 'boolean', description: 'fill_path: press Enter afterwards (default true).' },
    },
    required: ['action'],
  },
  async assess(a, rt) {
    if (a.action === 'detect' || a.action === 'read') return assessment('safe');
    if (a.action === 'cancel') return assessment('low');
    if (a.action === 'fill_path') {
      const p = a.path ? path.resolve(rt.paths.project.root, expandPath(a.path)) : null;
      if (p && isProtectedPath(p, rt.policy.protectedPaths)) return assessment('critical', [`targets protected path ${p}`], ['overwrite']);
      if (p && fs.existsSync(p) && (a.mode === 'save' || a.mode === undefined)) return assessment('medium', [`${p} already exists and may be overwritten`], ['overwrite']);
      return assessment('low');
    }
    let title = '';
    try {
      const d = await pickDialog(rt, a);
      title = d?.title ?? '';
    } catch {
      /* ignore */
    }
    const label = a.action === 'press' ? a.button : 'accept';
    const t = classifyUiTarget(`${label ?? ''} ${a.action === 'accept' ? title : ''}`);
    return { ...t, risk: maxRisk(t.risk, 'low') };
  },
  summary: (a) => `dialog ${a.action}${a.button ? ` "${a.button}"` : ''}${a.path ? ` ${a.path}` : ''}`,
  async handler(a, rt) {
    if (a.action === 'detect') {
      const dialogs = await rt.ui.detectDialogs({ selector: windowSelector(a) });
      return { count: dialogs.length, dialogs };
    }
    const d = await pickDialog(rt, a);
    if (!d) throw new ToolError(ErrorCode.NOT_FOUND, 'No dialog found', { hint: 'Take a screenshot: the dialog may be part of the main window (in-app dialog). Use ui_find/ui_action on its buttons.' });
    switch (a.action) {
      case 'read':
        return rt.ui.readDialog(d);
      case 'accept':
        return { dialog: d, ...(await rt.ui.pressDialogButton(d, { intent: 'accept' })) };
      case 'cancel':
        return { dialog: d, ...(await rt.ui.pressDialogButton(d, { intent: 'cancel' })) };
      case 'press':
        need(a, 'button');
        return { dialog: d, ...(await rt.ui.pressDialogButton(d, { button: a.button })) };
      case 'fill_path': {
        need(a, 'path');
        const res = await rt.ui.fillFileDialog(d, { filePath: path.resolve(rt.paths.project.root, expandPath(a.path)), mode: a.mode, submit: a.submit ?? true });
        await new Promise((r) => setTimeout(r, 600));
        const still = (await rt.backend.listWindows()).find((w) => w.id === d.id);
        res.dialog_closed = !still || still.title !== d.title;
        if (!res.dialog_closed) res.hint = 'The dialog is still open — a confirmation (e.g. "Replace existing file?") or validation error may be showing. Read it with ui_dialog read.';
        return { dialog: d, ...res };
      }
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

async function pickDialog(rt, a) {
  const sel = windowSelector(a);
  const dialogs = await rt.ui.detectDialogs({ selector: sel });
  if (sel.window_id) {
    const exact = dialogs.find((d) => d.id === sel.window_id);
    if (exact) return exact;
    const w = await resolveWindow(rt.backend, { window_id: sel.window_id }, { required: false });
    return w ? brief(w) : null;
  }
  return dialogs.find((d) => d.focused) ?? dialogs[dialogs.length - 1] ?? null;
}

export { uiTargetRisk };
