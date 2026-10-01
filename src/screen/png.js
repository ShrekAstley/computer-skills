import zlib from 'node:zlib';

/**
 * Minimal, dependency-free PNG codec plus raster helpers (crop, scale, diff).
 * Every capture backend produces a PNG; we normalise through RGBA so region
 * crops, downscaling for the model, and change detection behave identically
 * on every OS.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @typedef {{width: number, height: number, data: Uint8Array}} Image  RGBA, 8 bit */

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** Read width/height without decoding. */
export function pngSize(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** @returns {Image} */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG image');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (interlace) throw new Error('Interlaced PNG is not supported');
  if (bitDepth !== 8 && !(colorType === 3 && bitDepth <= 8) && !(colorType === 0 && bitDepth <= 8)) {
    if (bitDepth === 16) return decode16(Buffer.concat(idat), width, height, colorType);
    throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const lines = unfilter(raw, stride, height, bpp);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1];
      } else {
        let v;
        if (bitDepth === 8) v = line[x];
        else {
          const perByte = 8 / bitDepth;
          const byte = line[Math.floor(x / perByte)];
          const shift = 8 - bitDepth * ((x % perByte) + 1);
          v = (byte >> shift) & ((1 << bitDepth) - 1);
        }
        if (colorType === 3) {
          out[o] = palette[v * 3]; out[o + 1] = palette[v * 3 + 1]; out[o + 2] = palette[v * 3 + 2];
          out[o + 3] = trns && v < trns.length ? trns[v] : 255;
        } else {
          const g = bitDepth === 8 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
          out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255;
        }
      }
    }
  }
  return { width, height, data: out };
}

function decode16(compressed, width, height, colorType) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(compressed);
  const stride = width * channels * 2;
  const lines = unfilter(raw, stride, height, channels * 2);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels * 2;
      const o = (y * width + x) * 4;
      const c = (k) => lines[i + k * 2];
      if (channels >= 3) { out[o] = c(0); out[o + 1] = c(1); out[o + 2] = c(2); out[o + 3] = channels === 4 ? c(3) : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = c(0); out[o + 3] = channels === 2 ? c(1) : 255; }
    }
  }
  return { width, height, data: out };
}

function unfilter(raw, stride, height, bpp) {
  const out = new Uint8Array(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[p++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bad PNG filter ${filter}`);
      }
      out[row + x] = r & 0xff;
    }
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA → PNG (RGB when fully opaque, which is ~25% smaller). */
export function encodePng(img, { level = 6 } = {}) {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const ro = y * (stride + 1);
    raw[ro] = 1; // Sub filter: cheap and effective for screenshots
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = ro + 1 + x * ch;
      for (let k = 0; k < ch; k++) {
        const left = x > 0 ? data[si - 4 + k] : 0;
        raw[di + k] = (data[si + k] - left) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

/** Crop to a rectangle (clamped to the image). */
export function crop(img, { x, y, width, height }) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.floor(x + width)), y1 = Math.min(img.height, Math.floor(y + height));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const s = ((y0 + row) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Resize with area averaging (downscale) or bilinear (upscale). */
export function resize(img, width, height) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === img.width && height === img.height) return img;
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width, sy = img.height / height;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const ys = Math.floor(y * sy), ye = Math.min(img.height, Math.max(ys + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const xs = Math.floor(x * sx), xe = Math.min(img.width, Math.max(xs + 1, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = ys; yy < ye; yy++) {
          let i = (yy * img.width + xs) * 4;
          for (let xx = xs; xx < xe; xx++, i += 4) {
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++;
          }
        }
        const o = (y * width + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < width; x++) {
        const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), wx = fx - x0;
        const o = (y * width + x) * 4;
        for (let k = 0; k < 4; k++) {
          const p00 = img.data[(y0 * img.width + x0) * 4 + k], p01 = img.data[(y0 * img.width + x1) * 4 + k];
          const p10 = img.data[(y1 * img.width + x0) * 4 + k], p11 = img.data[(y1 * img.width + x1) * 4 + k];
          out[o + k] = (p00 * (1 - wx) + p01 * wx) * (1 - wy) + (p10 * (1 - wx) + p11 * wx) * wy;
        }
      }
    }
  }
  return { width, height, data: out };
}

/** Small grayscale thumbnail used for cheap change detection. */
export function fingerprint(img, size = 48) {
  const w = size, h = Math.max(1, Math.round((img.height / img.width) * size));
  const small = resize(img, w, h);
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (small.data[i * 4] * 299 + small.data[i * 4 + 1] * 587 + small.data[i * 4 + 2] * 114) / 1000;
  return { width: w, height: h, gray: g };
}

/** Fraction of thumbnail pixels that changed noticeably (0..1). */
export function diffFingerprints(a, b, threshold = 24) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0; i < a.gray.length; i++) if (Math.abs(a.gray[i] - b.gray[i]) > threshold) changed++;
  return changed / a.gray.length;
}

/**
 * Decode an X Window Dump (xwd -root) — a zero-dependency capture fallback on
 * X11 systems that have `xwd` but no ImageMagick/scrot/maim.
 */
export function decodeXwd(buf) {
  const headerSize = buf.readUInt32BE(0);
  const be = buf.readUInt32BE(4) === 7;
  const rd = (o) => (be ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
  const version = rd(4);
  if (version !== 7) throw new Error('Unsupported XWD version');
  const pixmapFormat = rd(8);
  const width = rd(16), height = rd(20);
  const byteOrder = rd(28); // 0 = LSBFirst
  const bitsPerPixel = rd(44);
  const bytesPerLine = rd(48);
  const redMask = rd(56), greenMask = rd(60), blueMask = rd(64);
  const ncolors = rd(76);
  if (pixmapFormat !== 2 || (bitsPerPixel !== 32 && bitsPerPixel !== 24)) throw new Error(`Unsupported XWD format (format ${pixmapFormat}, ${bitsPerPixel} bpp)`);
  const dataOff = headerSize + ncolors * 12;
  const shift = (m) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } return s; };
  const rs = shift(redMask), gs = shift(greenMask), bs = shift(blueMask);
  const bpp = bitsPerPixel / 8;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = dataOff + y * bytesPerLine + x * bpp;
      let px;
      if (bpp === 4) px = byteOrder === 0 ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
      else px = byteOrder === 0 ? buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) : (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
      const o = (y * width + x) * 4;
      out[o] = (px & redMask) >>> rs;
      out[o + 1] = (px & greenMask) >>> gs;
      out[o + 2] = (px & blueMask) >>> bs;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
