import path from 'node:path';
import fsp from 'node:fs/promises';
import { run, which } from '../core/exec.js';
import { ToolError, ErrorCode, missingDependency } from '../core/errors.js';
import { encodePng, resize } from './png.js';
import { ensureDir } from '../core/fsutil.js';

/**
 * OCR with pluggable engines:
 *  - tesseract (any OS, CLI)       — word boxes + confidences
 *  - native: Vision (macOS), Windows.Media.Ocr (Windows) via the backend
 * Results are always returned in logical screen coordinates.
 */
export class OcrService {
  constructor({ backend, screen, config, paths, logger }) {
    this.backend = backend;
    this.screen = screen;
    this.config = config;
    this.paths = paths;
    this.logger = logger;
  }

  engines() {
    const list = [];
    const pref = this.config.ocr?.engine ?? 'auto';
    const hasTess = !!which('tesseract');
    const nativeOk = process.platform === 'darwin' || process.platform === 'win32';
    if (pref === 'none') return [];
    if (pref === 'tesseract') return hasTess ? ['tesseract'] : [];
    if (pref === 'vision' || pref === 'windows' || pref === 'native') return nativeOk ? ['native'] : [];
    if (nativeOk) list.push('native');
    if (hasTess) list.push('tesseract');
    return list;
  }

  available() {
    return this.engines().length > 0;
  }

  /**
   * @param {{region?: object, window?: object, minConfidence?: number}} opts
   * @returns {Promise<{lines: object[], engine: string, region: object, text: string}>}
   */
  async read({ region, window, minConfidence = 30 } = {}) {
    const engines = this.engines();
    if (!engines.length) {
      throw missingDependency('OCR', process.platform === 'linux' ? 'Install tesseract-ocr (e.g. sudo apt install tesseract-ocr).' : 'Install tesseract or enable the native OCR engine.');
    }
    const { meta, image } = await this.screen.capture({ region, window, save: false, keepFullResolution: true });
    const scale = image.width / meta.region.width; // image px per logical px
    let lastErr;
    for (const engine of engines) {
      try {
        const upscale = engine === 'tesseract' ? Math.max(1, Math.min(3, Number(this.config.ocr?.upscale ?? 1))) : 1;
        const big = upscale > 1 && image.width * upscale <= 6000 ? resize(image, image.width * upscale, image.height * upscale) : image;
        const k = big.width / image.width;
        await ensureDir(this.paths.tmp);
        const file = path.join(this.paths.tmp, `ocr-${process.pid}-${Date.now()}.png`);
        await fsp.writeFile(file, encodePng(big, { level: 1 }));
        let lines;
        try {
          lines = engine === 'tesseract' ? await this._tesseract(file) : await this.backend.ocrNative(file);
        } finally {
          fsp.rm(file, { force: true }).catch(() => {});
        }
        if (!lines) continue;
        const toScreen = (b) => ({
          x: Math.round(meta.region.x + b.x / k / scale),
          y: Math.round(meta.region.y + b.y / k / scale),
          width: Math.round(b.width / k / scale),
          height: Math.round(b.height / k / scale),
        });
        const mapped = lines
          .filter((l) => (l.confidence ?? 100) >= minConfidence && l.text.trim())
          .map((l) => ({
            text: l.text.trim(),
            confidence: l.confidence,
            ...toScreen(l),
            words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence, ...toScreen(w) })),
          }));
        return { lines: mapped, engine, region: meta.region, text: mapped.map((l) => l.text).join('\n') };
      } catch (err) {
        lastErr = err;
        this.logger?.warn?.('ocr engine failed', { engine, error: err.message });
      }
    }
    throw lastErr ?? new ToolError(ErrorCode.BACKEND_FAILED, 'OCR failed');
  }

  async _tesseract(file) {
    const lang = this.config.ocr?.language || 'eng';
    const r = await run('tesseract', [file, 'stdout', '-l', lang, '--psm', '11', 'tsv'], { timeoutMs: 60000 });
    if (r.code !== 0) throw new ToolError(ErrorCode.BACKEND_FAILED, `tesseract failed: ${r.stderr.trim().slice(0, 300)}`);
    return parseTesseractTsv(r.stdout);
  }
}

/**
 * Parse tesseract TSV into lines of words. With --psm 11 (sparse text) every
 * word block is its own "line", so we regroup words by vertical overlap and
 * horizontal proximity — which matches how UI labels are laid out.
 */
export function parseTesseractTsv(tsv) {
  const words = [];
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const conf = Number(c[10]);
    if (!text || conf < 0) continue;
    words.push({ text, confidence: Math.round(conf), x: +c[6], y: +c[7], width: +c[8], height: +c[9], key: `${c[1]}.${c[2]}.${c[3]}.${c[4]}` });
  }
  return groupWords(words);
}

export function groupWords(words) {
  const sorted = words.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of sorted) {
    const cy = w.y + w.height / 2;
    let best = null;
    for (const l of lines) {
      const last = l.words[l.words.length - 1];
      const sameRow = cy >= l.y - 2 && cy <= l.y + l.height + 2 && Math.abs(last.height - w.height) < Math.max(last.height, w.height) * 0.6;
      const gap = w.x - (last.x + last.width);
      if (sameRow && gap > -last.height && gap < Math.max(last.height, w.height) * 1.6) {
        best = l;
        break;
      }
    }
    if (best) {
      best.words.push(w);
      const x2 = Math.max(best.x + best.width, w.x + w.width);
      const y2 = Math.max(best.y + best.height, w.y + w.height);
      best.x = Math.min(best.x, w.x);
      best.y = Math.min(best.y, w.y);
      best.width = x2 - best.x;
      best.height = y2 - best.y;
    } else {
      lines.push({ x: w.x, y: w.y, width: w.width, height: w.height, words: [w] });
    }
  }
  return lines.map((l) => {
    l.words.sort((a, b) => a.x - b.x);
    return {
      text: l.words.map((w) => w.text).join(' '),
      confidence: Math.round(l.words.reduce((s, w) => s + w.confidence, 0) / l.words.length),
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      words: l.words.map(({ key, ...w }) => w),
    };
  });
}
