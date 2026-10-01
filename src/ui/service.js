import path from 'node:path';
import { ToolError, ErrorCode } from '../core/errors.js';
import { matchScore, sleep, normText } from '../core/util.js';
import { parseCombo } from '../core/keys.js';
import { ElementRegistry, registerTree, flatten } from './elements.js';
import { resolveWindow, hasSelector, brief } from '../apps/windows.js';

const ACCEPT_LABELS = ['save', 'ok', 'open', 'export', 'import', 'yes', 'continue', 'done', 'select', 'choose', 'apply', 'confirm', 'allow', 'replace', 'overwrite', 'next', 'finish', 'install'];
const CANCEL_LABELS = ['cancel', 'no', 'close', 'dismiss', "don't allow", 'deny', 'not now', 'later', 'skip'];
const DIALOG_TITLE = /\b(save|open|export|import|confirm|warning|error|alert|dialog|replace|overwrite|permission|authenticat|choose|select|file|folder|print|preferences|settings|properties|unsaved|question|information|notice|attention|update)\b/i;

/**
 * Semantic UI layer: accessibility-tree inspection, element search that
 * combines accessibility and OCR, element actions with graceful fallbacks,
 * menu navigation and dialog handling.
 */
export class UiService {
  constructor({ backend, screen, ocr, input, config, logger }) {
    this.backend = backend;
    this.screen = screen;
    this.ocr = ocr;
    this.input = input; // InputService (for fallbacks)
    this.config = config;
    this.logger = logger;
    this.elements = new ElementRegistry();
  }

  async _target(win) {
    if (!win) return {};
    const t = { windowId: win.id, pid: win.pid, app: win.app, windowTitle: win.title };
    if (process.platform === 'linux' && win.pid) t.pids = [win.pid];
    return t;
  }

  async a11yAvailable() {
    const caps = await this.backend.capabilities().catch(() => ({}));
    return !!caps.accessibility?.available;
  }

  async inspect({ selector, depth = 8, maxNodes = 300, format = 'tree', interactiveOnly = false, includeMenus = false }) {
    const win = await resolveWindow(this.backend, selector, { required: true });
    if (!(await this.a11yAvailable())) {
      throw new ToolError(ErrorCode.DEPENDENCY_MISSING, 'Accessibility inspection is not available on this system', {
        hint: 'Use screen_capture to look at the window and screen_text / ui_find (method "ocr") to locate text.',
      });
    }
    const target = await this._target(win);
    // Linux AT-SPI scopes by app; pass the window title to narrow to this window.
    const { nodes, truncated } = await this.backend.a11yTree({ ...target, includeMenus }, { depth, maxNodes });
    const tree = registerTree(nodes, this.elements, win.id, { flat: format === 'flat', interactiveOnly });
    const res = { window: brief(win), format, elements: tree };
    if (truncated) res.truncated = true;
    if (!nodes.length || (format !== 'flat' && flatten(nodes).length <= 1)) {
      res.hint = 'The accessibility tree is empty: this app draws its own UI (games, Blender, many Electron/Java/Qt apps without a11y enabled). Use screen_capture + screen_text / ui_find(method "ocr") instead.';
    }
    return res;
  }

  /**
   * Find UI elements by visible text and/or role.
   * @returns {Promise<{matches: object[], method: string, window?: object}>}
   */
  async find({ text, role, selector, method = 'auto', limit = 8, exact = false, region, minScore = 0.6 }) {
    if (!text && !role) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Provide text and/or role to search for');
    const win = hasSelector(selector) ? await resolveWindow(this.backend, selector) : await resolveWindow(this.backend, null, { required: false });
    const matches = [];
    const tried = [];
    if ((method === 'auto' || method === 'a11y') && (await this.a11yAvailable()) && win) {
      tried.push('a11y');
      try {
        const nodes = await this._a11ySearch(win, { text, role, limit: limit * 3 });
        for (const n of nodes) {
          const label = [n.name, n.value, n.description, n.automationId].filter(Boolean).join(' ');
          const s = text ? Math.max(matchScore(text, n.name || '', { exact }), matchScore(text, n.value || '', { exact }) * 0.9, matchScore(text, n.description || '', { exact }) * 0.85, matchScore(text, n.automationId || '', { exact }) * 0.8) : 0.9;
          if (s < minScore) continue;
          if (role && !normText(n.role).includes(normText(role))) continue;
          if (!(n.width > 0)) continue; // invisible
          const rec = this.elements.add({ source: 'a11y', ref: n.ref, x: n.x, y: n.y, width: n.width, height: n.height, name: n.name, role: n.role, window: win.id });
          matches.push({ el: rec.id, source: 'a11y', score: round(s), text: n.name || label, role: n.role, bounds: [n.x, n.y, n.width, n.height], center: ElementRegistry.center(rec), enabled: n.enabled, actions: n.actions });
        }
      } catch (err) {
        this.logger?.debug?.('a11y search failed', { error: err.message });
        if (method === 'a11y') throw err;
      }
    }
    const good = matches.some((m) => m.score >= 0.85);
    if ((method === 'ocr' || (method === 'auto' && !good)) && text) {
      if (this.ocr.available()) {
        tried.push('ocr');
        const scope = region ?? (win ? { x: win.x, y: win.y, width: win.width, height: win.height } : undefined);
        const { lines } = await this.ocr.read({ region: scope });
        for (const hit of searchOcr(lines, text, { exact })) {
          if (hit.score < minScore) continue;
          const rec = this.elements.add({ source: 'ocr', ref: null, ...hit.box, name: hit.text, role: 'text', window: win?.id });
          matches.push({ el: rec.id, source: 'ocr', score: round(hit.score), text: hit.text, role: 'text', bounds: [hit.box.x, hit.box.y, hit.box.width, hit.box.height], center: ElementRegistry.center(rec), confidence: hit.confidence });
        }
      } else if (method === 'ocr') {
        throw new ToolError(ErrorCode.DEPENDENCY_MISSING, 'OCR is not available', { hint: 'Install tesseract.' });
      }
    }
    matches.sort((a, b) => b.score - a.score || (a.source === 'a11y' ? -1 : 1));
    const res = { matches: matches.slice(0, limit), methods: tried, window: brief(win) };
    if (!matches.length) {
      res.hint = `Nothing matched "${text ?? role}". Take a screenshot to see the current state; the element may be hidden in a menu, scrolled out of view, or labelled differently${tried.includes('ocr') ? '' : ' (OCR was not used)'}.`;
    }
    return res;
  }

  async _a11ySearch(win, { text, role, limit }) {
    const target = await this._target(win);
    if (this.backend.a11yFind) {
      // Search by a distinctive word: a11y names rarely match OCR-style phrases exactly.
      const needle = text ? normText(text).split(' ').sort((a, b) => b.length - a.length)[0] : undefined;
      try {
        return await this.backend.a11yFind(target, { name: needle, role: text ? undefined : role, limit });
      } catch (err) {
        if (err.code !== ErrorCode.UNSUPPORTED) throw err;
      }
    }
    const { nodes } = await this.backend.a11yTree(target, { depth: 12, maxNodes: 1500 });
    return flatten(nodes);
  }

  /**
   * Act on an element: press/click/focus/set_value/toggle/expand/collapse/select.
   * Falls back to pointer/keyboard when the element has no matching a11y pattern.
   */
  async act({ element, action = 'press', value }) {
    const rec = this.elements.get(element);
    const center = ElementRegistry.center(rec);
    if (rec.source === 'a11y' && rec.ref) {
      try {
        const r = await this.backend.a11yAction(rec.ref, action, value);
        return { element, action, method: 'accessibility', performed: r?.performed ?? action, name: rec.name };
      } catch (err) {
        if (![ErrorCode.UNSUPPORTED, ErrorCode.BACKEND_FAILED].includes(err.code) || !center) throw err;
        this.logger?.debug?.('a11y action failed; falling back to pointer', { error: err.message });
      }
    }
    if (!center) throw new ToolError(ErrorCode.UNSUPPORTED, `Element ${element} has no screen position to fall back on`);
    switch (action) {
      case 'press': case 'click': case 'invoke': case 'activate': case 'toggle': case 'select': case 'expand': case 'collapse':
        await this.input.click({ ...center, button: 'left', count: 1 });
        break;
      case 'double_click':
        await this.input.click({ ...center, button: 'left', count: 2 });
        break;
      case 'focus':
        await this.input.click({ ...center, button: 'left', count: 1 });
        break;
      case 'set_value':
        await this.input.click({ ...center, button: 'left', count: 1 });
        await sleep(80);
        await this.input.key(parseCombo('mod+a'));
        await this.input.type(String(value ?? ''));
        break;
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${action}`);
    }
    return { element, action, method: 'pointer', at: center, name: rec.name };
  }

  /** Navigate a menu path, e.g. ["File", "Export", "PNG"]. */
  async menu({ selector, path: items, method = 'auto', delayMs = 350 }) {
    if (!Array.isArray(items) || !items.length) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'path must be a non-empty array of menu labels');
    const win = await resolveWindow(this.backend, selector);
    if (method === 'auto' || method === 'native') {
      try {
        const t = await this._target(win);
        const r = await this.backend.menuSelect(t, items);
        return { path: items, method: r?.method ?? 'native', window: brief(win) };
      } catch (err) {
        if (method === 'native' || ![ErrorCode.UNSUPPORTED, ErrorCode.NOT_FOUND, ErrorCode.BACKEND_FAILED].includes(err.code)) throw err;
        this.logger?.debug?.('native menu failed, using visual navigation', { error: err.message });
      }
    }
    // Visual fallback: find each label on screen and click it.
    await this.backend.windowAction(win.id, 'focus').catch(() => {});
    await sleep(150);
    const steps = [];
    for (let i = 0; i < items.length; i++) {
      // The first item lives in the window's menu bar; submenus pop up anywhere on screen.
      const region = i === 0 ? { x: win.x, y: win.y, width: win.width, height: Math.min(win.height, 140) } : undefined;
      let r = await this.find({ text: items[i], method: i === 0 ? 'auto' : 'ocr', selector: i === 0 ? { window_id: win.id } : null, region, limit: 3 });
      if (!r.matches.length && i === 0) r = await this.find({ text: items[i], method: 'ocr', selector: { window_id: win.id }, limit: 3 });
      const hit = r.matches[0];
      if (!hit) {
        throw new ToolError(ErrorCode.NOT_FOUND, `Menu item "${items[i]}" not found (step ${i + 1} of ${items.length})`, {
          hint: 'Take a screenshot to see which menu is open. Labels may differ by version/language; press escape to close open menus before retrying.',
          details: { completed: steps },
        });
      }
      await this.input.click({ ...hit.center, button: 'left', count: 1 });
      steps.push({ label: items[i], at: hit.center, source: hit.source });
      await sleep(delayMs);
    }
    return { path: items, method: 'visual', steps, window: brief(win) };
  }

  /** Locate dialogs (modal windows, sheets, message boxes). */
  async detectDialogs({ selector } = {}) {
    const wins = await this.backend.listWindows();
    let parent = null;
    if (hasSelector(selector)) parent = await resolveWindow(this.backend, selector, { required: false });
    const out = [];
    if (this.backend.dialogsOf && parent?.pid) {
      for (const d of await this.backend.dialogsOf(parent.pid).catch(() => [])) out.push({ ...brief(d), kind: 'owned-window' });
    }
    for (const w of wins) {
      if (out.some((o) => o.id === w.id)) continue;
      const small = w.width > 0 && w.width < 900 && w.height < 700;
      if (DIALOG_TITLE.test(w.title || '') && (small || w.focused)) out.push({ ...brief(w), kind: 'window' });
      else if (parent && w.pid === parent.pid && w.id !== parent.id && small) out.push({ ...brief(w), kind: 'secondary-window' });
    }
    // macOS sheets / in-window dialogs show up in the accessibility tree.
    if (process.platform === 'darwin' && parent && (await this.a11yAvailable())) {
      try {
        const sheets = await this.backend.a11yFind(await this._target(parent), { role: 'sheet', limit: 3 });
        for (const s of sheets) out.push({ id: parent.id, title: s.name || parent.title, kind: 'sheet', x: s.x, y: s.y, width: s.width, height: s.height });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async readDialog(d) {
    const res = { dialog: d };
    if (this.ocr.available() && d.width > 0) {
      try {
        const { text } = await this.ocr.read({ region: { x: d.x, y: d.y, width: d.width, height: d.height } });
        res.text = text.slice(0, 2000);
      } catch (err) {
        res.text_error = err.message;
      }
    }
    if (await this.a11yAvailable()) {
      try {
        const buttons = await this.backend.a11yFind({ windowId: d.id, pid: d.pid, app: d.app, windowTitle: d.title }, { role: 'button', limit: 12 });
        res.buttons = buttons.filter((b) => b.name).map((b) => {
          const rec = this.elements.add({ source: 'a11y', ref: b.ref, x: b.x, y: b.y, width: b.width, height: b.height, name: b.name, role: b.role, window: d.id });
          return { el: rec.id, name: b.name };
        });
      } catch {
        /* ignore */
      }
    }
    return res;
  }

  /** Press a dialog button by label (or the default/cancel key). */
  async pressDialogButton(d, { button, intent }) {
    await this.backend.windowAction(d.id, 'focus').catch(() => {});
    await sleep(120);
    const labels = button ? [button] : intent === 'accept' ? ACCEPT_LABELS : CANCEL_LABELS;
    for (const label of labels) {
      const r = await this.find({ text: label, selector: { window_id: d.id }, region: { x: d.x, y: d.y, width: d.width, height: d.height }, limit: 3, minScore: button ? 0.8 : 0.95 }).catch(() => ({ matches: [] }));
      const hit = r.matches.find((m) => m.source === 'a11y' ? /button/i.test(m.role) || !m.role : true);
      if (hit) {
        await this.act({ element: hit.el, action: 'press' });
        return { pressed: hit.text, method: hit.source };
      }
    }
    if (button) throw new ToolError(ErrorCode.NOT_FOUND, `No button "${button}" found in dialog "${d.title}"`);
    await this.input.key(parseCombo(intent === 'accept' ? 'enter' : 'escape'));
    return { pressed: intent === 'accept' ? 'enter (default button)' : 'escape', method: 'keyboard' };
  }

  /** Type a path into a native open/save file dialog. */
  async fillFileDialog(d, { filePath, mode, submit = true }) {
    const abs = path.resolve(filePath);
    const isSave = mode ? mode === 'save' : /save|export/i.test(d.title || '');
    await this.backend.windowAction(d.id, 'focus').catch(() => {});
    await sleep(150);
    const k = (c) => this.input.key(parseCombo(c));
    if (process.platform === 'darwin') {
      if (isSave) {
        await k('mod+a');
        await this.input.type(path.basename(abs));
        await k('meta+shift+g');
        await sleep(400);
        await this.input.type(path.dirname(abs));
        await k('enter');
        await sleep(400);
      } else {
        await k('meta+shift+g');
        await sleep(400);
        await this.input.type(abs);
        await k('enter');
        await sleep(400);
      }
    } else if (process.platform === 'win32') {
      await k('alt+n'); // focus "File name"
      await sleep(100);
      await k('mod+a');
      await this.input.type(abs);
    } else {
      // GTK: typing a path starting with "/" opens the location entry; Qt/KDE accept full paths in the name field.
      if (!isSave) {
        await k('ctrl+l');
        await sleep(150);
      }
      await k('mod+a');
      await this.input.type(abs);
    }
    if (submit) {
      await sleep(150);
      await k('enter');
    }
    return { path: abs, mode: isSave ? 'save' : 'open', submitted: submit };
  }
}

/** Search OCR lines for a phrase, matching whole lines and word n-grams. */
export function searchOcr(lines, text, { exact = false } = {}) {
  const hits = [];
  const qWords = normText(text).split(' ').filter(Boolean);
  for (const line of lines) {
    const lineScore = matchScore(text, line.text, { exact });
    if (lineScore > 0) hits.push({ text: line.text, score: lineScore, box: { x: line.x, y: line.y, width: line.width, height: line.height }, confidence: line.confidence });
    const words = line.words || [];
    if (words.length < 2) continue;
    const n = qWords.length;
    for (let i = 0; i + n <= words.length; i++) {
      const slice = words.slice(i, i + n);
      const phrase = slice.map((w) => w.text).join(' ');
      const s = matchScore(text, phrase, { exact });
      if (s <= 0) continue;
      const x = Math.min(...slice.map((w) => w.x));
      const y = Math.min(...slice.map((w) => w.y));
      const x2 = Math.max(...slice.map((w) => w.x + w.width));
      const y2 = Math.max(...slice.map((w) => w.y + w.height));
      // A precise word-level hit beats a whole-line hit with the same text.
      hits.push({ text: phrase, score: Math.min(1, s + 0.01), box: { x, y, width: x2 - x, height: y2 - y }, confidence: Math.round(slice.reduce((a, w) => a + (w.confidence ?? 90), 0) / slice.length) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.box.width - b.box.width);
  // Drop near-duplicates (same spot)
  const out = [];
  for (const h of hits) {
    if (out.some((o) => Math.abs(o.box.x - h.box.x) < 4 && Math.abs(o.box.y - h.box.y) < 4 && o.text === h.text)) continue;
    out.push(h);
  }
  return out;
}

const round = (n) => Math.round(n * 100) / 100;
