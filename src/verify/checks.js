import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, ErrorCode } from '../core/errors.js';
import { sleep, matchScore } from '../core/util.js';
import { expandPath } from '../core/paths.js';
import { selectWindows, brief } from '../apps/windows.js';
import { listSystemProcesses, isPidRunning, portOpen } from '../terminal/processes.js';
import { searchOcr } from '../ui/service.js';

/**
 * Observable checks: the vocabulary used both by the `verify` tool and by
 * workflow step expectations. Every check returns evidence, so the agent can
 * reason about *why* something passed or failed.
 */
export const CHECK_TYPES = {
  window_exists: 'A window matching {title|title_regex|app|pid|window_id} exists',
  window_absent: 'No window matches the selector',
  window_focused: 'The focused window matches the selector',
  text_visible: 'OCR/accessibility finds {text} (or {regex}) on screen, optionally within {window selector} or {region}',
  text_absent: 'The text is not visible',
  element_exists: 'An accessibility element named {text} (optional {role}) exists in the window',
  file_exists: 'File {path} exists (optional {min_bytes}, {modified_within_s}, {modified_after_start})',
  file_absent: 'File {path} does not exist',
  file_contains: 'File {path} contains {text} or matches {regex}',
  process_running: 'A process named {name} or with {pid} is running',
  process_absent: 'No such process is running',
  port_open: 'TCP {port} on {host=127.0.0.1} accepts connections',
  http_ok: 'GET {url} returns {status=2xx} (optional {contains})',
  command_succeeds: 'Shell {command} exits 0 (optional {stdout_regex})',
  screen_changed: 'The screen (or {region}) changed by at least {min_fraction=0.01} since {screenshot_id}',
  clipboard_contains: 'Clipboard contains {text}',
};

const WINDOW_KEYS = ['window_id', 'title', 'title_regex', 'app', 'pid'];
const pickSel = (c) => Object.fromEntries(WINDOW_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

export function validateCheck(c) {
  if (!c || typeof c !== 'object') throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'A check must be an object with a "type"');
  if (!CHECK_TYPES[c.type]) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown check type "${c.type}"`, { details: { known: Object.keys(CHECK_TYPES) } });
  const need = {
    text_visible: ['text|regex'], text_absent: ['text|regex'], element_exists: ['text|role'], file_exists: ['path'], file_absent: ['path'], file_contains: ['path', 'text|regex'],
    process_running: ['name|pid'], process_absent: ['name|pid'], port_open: ['port'], http_ok: ['url'], command_succeeds: ['command'], screen_changed: ['screenshot_id'], clipboard_contains: ['text'],
  }[c.type] || [];
  for (const req of need) {
    if (!req.split('|').some((k) => c[k] !== undefined && c[k] !== '')) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Check ${c.type} requires ${req.replace('|', ' or ')}`);
  }
  return c;
}

/**
 * @param {object} check
 * @param {{backend, screen, ocr, ui, runCommand, startedAt?: number, cwd?: string}} ctx
 */
export async function evaluateCheck(check, ctx) {
  const c = validateCheck(check);
  try {
    switch (c.type) {
      case 'window_exists':
      case 'window_absent':
      case 'window_focused': {
        const wins = await ctx.backend.listWindows();
        const hits = selectWindows(wins, pickSel(c));
        if (c.type === 'window_exists') return result(c, hits.length > 0, hits.length ? `found "${hits[0].title}"` : 'no matching window', { windows: hits.slice(0, 3).map(brief) });
        if (c.type === 'window_absent') return result(c, hits.length === 0, hits.length ? `still open: "${hits[0].title}"` : 'no matching window');
        const focused = wins.find((w) => w.focused);
        const ok = !!focused && hits.some((h) => h.id === focused.id);
        return result(c, ok, focused ? `focused: "${focused.title}"` : 'no focused window', { focused: brief(focused) });
      }
      case 'text_visible':
      case 'text_absent': {
        const found = await findText(c, ctx);
        const ok = c.type === 'text_visible' ? !!found : !found;
        return result(c, ok, found ? `found "${found.text}" via ${found.source}` : 'text not found', found ? { at: found.box } : undefined);
      }
      case 'element_exists': {
        const r = await ctx.ui.find({ text: c.text, role: c.role, selector: pickSel(c), method: 'a11y', limit: 1, minScore: c.exact ? 1 : 0.75 });
        return result(c, r.matches.length > 0, r.matches.length ? `found ${r.matches[0].role} "${r.matches[0].text}"` : 'no matching element', r.matches[0] ? { el: r.matches[0].el } : undefined);
      }
      case 'file_exists':
      case 'file_absent': {
        const p = resolvePath(c.path, ctx);
        let st = null;
        try {
          st = await fsp.stat(p);
        } catch {
          st = null;
        }
        if (c.type === 'file_absent') return result(c, !st, st ? `exists (${st.size} bytes)` : 'absent', { path: p });
        if (!st) return result(c, false, 'file does not exist', { path: p });
        const problems = [];
        if (c.min_bytes !== undefined && st.size < c.min_bytes) problems.push(`size ${st.size} < ${c.min_bytes}`);
        if (c.modified_within_s !== undefined && Date.now() - st.mtimeMs > c.modified_within_s * 1000) problems.push(`last modified ${Math.round((Date.now() - st.mtimeMs) / 1000)}s ago`);
        if (c.modified_after_start && ctx.startedAt && st.mtimeMs < ctx.startedAt - 1000) problems.push('not modified during this run');
        return result(c, problems.length === 0, problems.length ? problems.join('; ') : `exists (${st.size} bytes)`, { path: p, size: st.size, modified: new Date(st.mtimeMs).toISOString() });
      }
      case 'file_contains': {
        const p = resolvePath(c.path, ctx);
        let text;
        try {
          text = await fsp.readFile(p, 'utf8');
        } catch {
          return result(c, false, 'file not readable', { path: p });
        }
        const ok = c.regex ? new RegExp(c.regex, 'm').test(text) : text.includes(c.text);
        return result(c, ok, ok ? 'content matches' : 'content does not match', { path: p });
      }
      case 'process_running':
      case 'process_absent': {
        let running;
        let detail;
        if (c.pid) {
          running = isPidRunning(Number(c.pid));
          detail = `pid ${c.pid} ${running ? 'running' : 'not running'}`;
        } else {
          const { processes } = await listSystemProcesses({ filter: c.name, limit: 5 });
          const exact = processes.filter((p) => p.name.toLowerCase().replace(/\.exe$/, '') === String(c.name).toLowerCase().replace(/\.exe$/, ''));
          const hits = c.exact === false ? processes : exact.length ? exact : processes.filter((p) => p.name.toLowerCase().includes(String(c.name).toLowerCase()));
          running = hits.length > 0;
          detail = running ? `running: ${hits.map((p) => `${p.name}(${p.pid})`).slice(0, 3).join(', ')}` : 'not running';
        }
        return result(c, c.type === 'process_running' ? running : !running, detail);
      }
      case 'port_open': {
        const open = await portOpen(Number(c.port), c.host || '127.0.0.1', 1000);
        return result(c, open, open ? 'accepting connections' : 'closed');
      }
      case 'http_ok': {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), c.timeout_ms ?? 8000);
        try {
          const res = await fetch(c.url, { signal: ac.signal, redirect: 'follow' });
          const body = c.contains ? await res.text() : '';
          const statusOk = c.status ? res.status === c.status : res.ok;
          const containsOk = c.contains ? body.includes(c.contains) : true;
          return result(c, statusOk && containsOk, `HTTP ${res.status}${c.contains ? (containsOk ? ', body matches' : ', body does not contain text') : ''}`);
        } catch (err) {
          return result(c, false, `request failed: ${err.message}`);
        } finally {
          clearTimeout(t);
        }
      }
      case 'command_succeeds': {
        const r = await ctx.runCommand({ command: c.command, shell: c.shell, cwd: c.cwd, timeoutMs: c.timeout_ms ?? 30000 });
        let ok = r.exit_code === 0;
        if (ok && c.stdout_regex) ok = new RegExp(c.stdout_regex, 'm').test(r.stdout);
        return result(c, ok, `exit ${r.exit_code}`, { stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-300) || undefined });
      }
      case 'screen_changed': {
        const frac = await ctx.screen.changedSince(c.screenshot_id, c.region);
        const min = c.min_fraction ?? 0.01;
        return result(c, frac >= min, `${Math.round(frac * 1000) / 10}% of the area changed`, { changed_fraction: frac });
      }
      case 'clipboard_contains': {
        const text = await ctx.backend.clipboardRead();
        return result(c, String(text).includes(c.text), String(text).includes(c.text) ? 'clipboard matches' : 'clipboard does not contain text');
      }
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown check ${c.type}`);
    }
  } catch (err) {
    if (err instanceof ToolError && (err.code === ErrorCode.INVALID_ARGUMENT || err.code === ErrorCode.KILL_SWITCH || err.code === ErrorCode.POLICY_DENIED || err.code === ErrorCode.CONFIRMATION_REQUIRED)) throw err;
    return { type: c.type, ok: false, detail: `check could not be evaluated: ${err.message}`, error: err.code ?? 'ERROR' };
  }
}

async function findText(c, ctx) {
  const sel = pickSel(c);
  let region = c.region;
  if (!region && Object.keys(sel).length) {
    const wins = selectWindows(await ctx.backend.listWindows(), sel);
    if (!wins.length) return null;
    region = { x: wins[0].x, y: wins[0].y, width: wins[0].width, height: wins[0].height };
  }
  if (c.regex) {
    const { lines } = await ctx.ocr.read({ region });
    const re = new RegExp(c.regex, 'i');
    const line = lines.find((l) => re.test(l.text));
    return line ? { text: line.text, source: 'ocr', box: { x: line.x, y: line.y, width: line.width, height: line.height } } : null;
  }
  if (ctx.ocr.available()) {
    const { lines } = await ctx.ocr.read({ region });
    const hit = searchOcr(lines, c.text, { exact: c.exact })[0];
    if (hit && hit.score >= (c.min_score ?? 0.8)) return { text: hit.text, source: 'ocr', box: hit.box };
  }
  // Accessibility as a second opinion (also covers systems without OCR).
  try {
    const r = await ctx.ui.find({ text: c.text, selector: sel, method: 'a11y', limit: 1 });
    const m = r.matches[0];
    if (m && matchScore(c.text, m.text) >= (c.min_score ?? 0.8)) return { text: m.text, source: 'a11y', box: m.bounds };
  } catch {
    /* a11y unavailable */
  }
  return null;
}

function resolvePath(p, ctx) {
  return path.resolve(ctx.cwd || process.cwd(), expandPath(p));
}

function result(check, ok, detail, evidence) {
  const r = { type: check.type, ok: !!ok, detail };
  if (check.label) r.label = check.label;
  if (evidence) r.evidence = evidence;
  return r;
}

/**
 * Evaluate checks, polling until they pass or the timeout elapses.
 * @returns {Promise<{ok: boolean, elapsed_ms: number, attempts: number, results: object[]}>}
 */
export async function verifyChecks(checks, ctx, { timeoutMs = 0, intervalMs = 500, mode = 'all', signal } = {}) {
  const start = Date.now();
  let attempts = 0;
  let results = [];
  for (;;) {
    attempts++;
    results = [];
    for (const c of checks) results.push(await evaluateCheck(c, ctx));
    const ok = mode === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
    if (ok || Date.now() - start >= timeoutMs || signal?.aborted) {
      return { ok, elapsed_ms: Date.now() - start, attempts, results };
    }
    await sleep(Math.min(intervalMs, Math.max(50, timeoutMs - (Date.now() - start))), signal).catch(() => {});
  }
}
