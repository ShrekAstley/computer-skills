import { ToolError, ErrorCode } from '../core/errors.js';
import { matchScore } from '../core/util.js';

/**
 * Window selectors. Tools accept any of:
 *   { window_id }                         exact id from window list
 *   { title: "Untitled - Notepad" }       fuzzy title match
 *   { title_regex: "\\.blend" }           regex on the title
 *   { app: "blender" }                    app/process/class name
 *   { pid: 1234 }                         owning process
 * Multiple fields narrow the match.
 */
export function windowMatches(win, sel, { pids } = {}) {
  if (!sel) return 1;
  let score = 1;
  if (sel.window_id !== undefined && sel.window_id !== null) {
    if (String(win.id).toLowerCase() !== String(sel.window_id).toLowerCase()) return 0;
  }
  if (sel.pid !== undefined && sel.pid !== null) {
    const set = pids ?? new Set([Number(sel.pid)]);
    if (!set.has(Number(win.pid))) return 0;
  }
  if (sel.title_regex) {
    let re;
    try {
      re = new RegExp(sel.title_regex, 'i');
    } catch {
      throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Invalid title_regex: ${sel.title_regex}`);
    }
    if (!re.test(win.title || '')) return 0;
  }
  if (sel.title) {
    const s = Math.max(matchScore(sel.title, win.title || ''), (win.title || '').toLowerCase().includes(String(sel.title).toLowerCase()) ? 0.85 : 0);
    if (s < 0.6) return 0;
    score *= s;
  }
  if (sel.app) {
    const hay = `${win.app || ''} ${win.className || ''}`;
    const a = String(sel.app).toLowerCase();
    let s = matchScore(sel.app, win.app || '') || matchScore(sel.app, win.className || '');
    if (!s && hay.toLowerCase().includes(a)) s = 0.85;
    if (!s && (win.title || '').toLowerCase().includes(a)) s = 0.7; // many apps put their name in the title
    if (s < 0.6) return 0;
    score *= s;
  }
  return score;
}

export function hasSelector(sel) {
  return !!sel && ['window_id', 'pid', 'title', 'title_regex', 'app'].some((k) => sel[k] !== undefined && sel[k] !== null && sel[k] !== '');
}

/** Pick the best matching window, preferring focused and larger windows on ties. */
export function selectWindows(windows, sel, opts) {
  return windows
    .map((w) => ({ w, s: windowMatches(w, sel, opts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(!!b.w.focused) - Number(!!a.w.focused) || b.w.width * b.w.height - a.w.width * a.w.height)
    .map((x) => x.w);
}

export async function resolveWindow(backend, sel, { required = true, pids } = {}) {
  const wins = await backend.listWindows();
  if (!hasSelector(sel)) {
    const active = wins.find((w) => w.focused) ?? null;
    if (!active && required) throw new ToolError(ErrorCode.NOT_FOUND, 'No focused window', { hint: 'Pass a window selector (window_id, title, app or pid).' });
    return active;
  }
  const hit = selectWindows(wins, sel, { pids })[0] ?? null;
  if (!hit && required) {
    throw new ToolError(ErrorCode.NOT_FOUND, `No window matches ${JSON.stringify(sel)}`, {
      hint: 'List windows with window action "list" to see titles and ids. The app may not have opened yet (use verify window_exists with a timeout).',
      details: { open_windows: wins.slice(0, 15).map((w) => ({ id: w.id, title: w.title, app: w.app })) },
    });
  }
  return hit;
}

/** Compact window description for results. */
export function brief(w) {
  if (!w) return null;
  const out = { id: w.id, title: w.title, app: w.app, pid: w.pid, x: w.x, y: w.y, width: w.width, height: w.height };
  if (w.focused) out.focused = true;
  if (w.minimized) out.minimized = true;
  return out;
}
