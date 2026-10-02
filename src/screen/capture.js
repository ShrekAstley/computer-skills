import path from 'node:path';
import fsp from 'node:fs/promises';
import { decodePng, encodePng, crop, resize, fingerprint, diffFingerprints } from './png.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { pruneDir, ensureDir } from '../core/fsutil.js';
import { shortId } from '../core/util.js';

/**
 * Screen capture service. Every capture is normalised: cropped to the
 * requested region/window in *logical* coordinates, downscaled to a model
 * friendly width, saved to disk and registered under an id. Later actions can
 * pass `screenshot_id` + image coordinates and get mapped back to the screen.
 */
export class ScreenService {
  constructor({ backend, config, paths, logger }) {
    this.backend = backend;
    this.config = config;
    this.paths = paths;
    this.logger = logger;
    this.shots = new Map(); // id -> meta
    this.order = [];
  }

  /** Raw full-screen capture decoded to RGBA plus mapping info. */
  async grab() {
    const cap = await this.backend.capture();
    const img = decodePng(cap.png);
    return { img, pixelRatio: cap.pixelRatio || 1, origin: cap.origin || { x: 0, y: 0 }, method: cap.method };
  }

  /**
   * @param {{region?: {x:number,y:number,width:number,height:number}, window?: object, maxWidth?: number, save?: boolean}} opts
   */
  async capture({ region, window, maxWidth, save = true, keepFullResolution = false } = {}) {
    const started = Date.now();
    const { img, pixelRatio, origin, method } = await this.grab();
    let logical = { x: origin.x, y: origin.y, width: Math.round(img.width / pixelRatio), height: Math.round(img.height / pixelRatio) };
    if (window) region = { x: window.x, y: window.y, width: window.width, height: window.height };
    let out = img;
    if (region) {
      const r = clampRegion(region, logical);
      if (r.width <= 0 || r.height <= 0) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Requested region is outside the screen', { details: { region, screen: logical } });
      out = crop(img, { x: (r.x - origin.x) * pixelRatio, y: (r.y - origin.y) * pixelRatio, width: r.width * pixelRatio, height: r.height * pixelRatio });
      logical = r;
    }
    const full = out;
    const limit = keepFullResolution ? Infinity : (maxWidth ?? this.config.screen.maxWidth ?? 1568);
    if (out.width > limit) out = resize(out, limit, Math.round((out.height * limit) / out.width));
    const scale = out.width / logical.width; // image px per logical px
    const id = shortId('shot-');
    const meta = {
      id,
      region: logical,
      scale,
      width: out.width,
      height: out.height,
      at: new Date().toISOString(),
      fingerprint: fingerprint(full),
      method,
    };
    const png = encodePng(out);
    if (save) {
      await ensureDir(this.paths.screenshots);
      meta.path = path.join(this.paths.screenshots, `${id}.png`);
      await fsp.writeFile(meta.path, png);
      pruneDir(this.paths.screenshots, this.config.screen.keepScreenshots ?? 60).catch(() => {});
    }
    this._remember(meta);
    this.logger?.debug?.('capture', { id, ms: Date.now() - started, w: out.width, h: out.height, method });
    return { meta, png, image: full };
  }

  _remember(meta) {
    this.shots.set(meta.id, meta);
    this.order.push(meta.id);
    while (this.order.length > 200) this.shots.delete(this.order.shift());
  }

  get(id) {
    const m = this.shots.get(id);
    if (!m) throw new ToolError(ErrorCode.NOT_FOUND, `Unknown screenshot id ${id}`, { hint: 'Screenshot ids are kept in memory for this server session only. Take a new screenshot.' });
    return m;
  }

  latest() {
    const id = this.order[this.order.length - 1];
    return id ? this.shots.get(id) : null;
  }

  /** Map a point in a screenshot's image space to logical screen coordinates. */
  toScreen(id, x, y) {
    const m = this.get(id);
    return { x: Math.round(m.region.x + x / m.scale), y: Math.round(m.region.y + y / m.scale) };
  }

  /** Fraction of the region that changed since screenshot `id` (0..1). */
  async changedSince(id, region) {
    const m = this.get(id);
    const { image } = await this.capture({ region: region ?? m.region, save: false });
    return diffFingerprints(m.fingerprint, fingerprint(image));
  }
}

export function clampRegion(r, bounds) {
  const x = Math.max(bounds.x, Math.round(r.x));
  const y = Math.max(bounds.y, Math.round(r.y));
  const x2 = Math.min(bounds.x + bounds.width, Math.round(r.x + r.width));
  const y2 = Math.min(bounds.y + bounds.height, Math.round(r.y + r.height));
  return { x, y, width: x2 - x, height: y2 - y };
}
