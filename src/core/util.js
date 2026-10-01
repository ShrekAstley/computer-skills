import crypto from 'node:crypto';

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

export const nowIso = () => new Date().toISOString();

export function shortId(prefix = '') {
  return prefix + crypto.randomBytes(5).toString('hex');
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Stable JSON stringify (sorted keys) used for hashing argument objects. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Truncate long text keeping head and tail, which is where the useful output usually is. */
export function truncateMiddle(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n…[${omitted} characters omitted]…\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Normalise text for fuzzy matching. */
export function normText(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\p{L}\p{N}.'"/:+\-_ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance with adjacent transpositions (optimal string alignment), so "exprot" ≈ "export". */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => {
    const r = new Array(cols).fill(0);
    r[0] = i;
    return r;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Similarity in [0,1]: 1 = identical (after normalisation). */
export function similarity(a, b) {
  const x = normText(a);
  const y = normText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}

/** Score how well `candidate` matches the `query` text (exact > prefix > contains > fuzzy). */
export function matchScore(query, candidate, { exact = false } = {}) {
  const q = normText(query);
  const c = normText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (exact) return 0;
  // Ignore trailing ellipsis / colon / mnemonic punctuation differences ("Save As..." vs "save as")
  const strip = (s) => s.replace(/(\.\.\.|:)$/g, '').trim();
  if (strip(q) === strip(c)) return 0.97;
  if (c.startsWith(q)) return 0.9 - Math.min(0.2, (c.length - q.length) / 100);
  const words = c.split(' ');
  if (words.includes(q)) return 0.85;
  if (c.includes(q)) return 0.8 - Math.min(0.2, (c.length - q.length) / 200);
  const sim = similarity(q, c);
  return sim >= 0.7 ? sim * 0.8 : 0;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function deepMerge(target, source) {
  if (Array.isArray(source)) return source.slice();
  if (!source || typeof source !== 'object') return source;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** Run async fn over items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Parse "1.2.3" style versions into comparable arrays. */
export function parseVersion(v) {
  const m = String(v ?? '').match(/\d+(?:\.\d+)*/);
  return m ? m[0].split('.').map(Number) : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a) || [];
  const y = parseVersion(b) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Evaluate a simple version range like ">=3.6", "<5", "3.x", ">=3.0 <5.0". */
export function versionSatisfies(version, range) {
  if (!range || range === '*' || !version) return true;
  return String(range)
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      const m = part.match(/^(>=|<=|>|<|=|\^|~)?\s*([\dx.*]+)$/);
      if (!m) return true;
      const [, op = '=', target] = m;
      if (/[x*]/.test(target)) {
        const prefix = target.split('.').filter((s) => !/[x*]/.test(s));
        const v = parseVersion(version) || [];
        return prefix.every((p, i) => Number(p) === v[i]);
      }
      const c = compareVersions(version, target);
      switch (op) {
        case '>=': return c >= 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '<': return c < 0;
        case '^': return c >= 0 && (parseVersion(version)?.[0] ?? -1) === (parseVersion(target)?.[0] ?? -2);
        case '~': {
          const v = parseVersion(version) || [];
          const t = parseVersion(target) || [];
          return c >= 0 && v[0] === t[0] && v[1] === t[1];
        }
        default: return c === 0;
      }
    });
}
