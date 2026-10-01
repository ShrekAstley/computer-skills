import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodePng, decodePng, crop, resize, fingerprint, diffFingerprints, pngSize, decodeXwd, isPng } from '../../src/screen/png.js';

function gradient(w, h, alpha = 255) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    data[i] = x * 3; data[i + 1] = y * 5; data[i + 2] = (x + y) % 256; data[i + 3] = alpha;
  }
  return { width: w, height: h, data };
}

test('encode/decode round trip (RGB and RGBA)', () => {
  for (const alpha of [255, 128]) {
    const img = gradient(37, 23, alpha);
    const png = encodePng(img);
    assert.ok(isPng(png));
    assert.deepEqual(pngSize(png), { width: 37, height: 23 });
    const back = decodePng(png);
    assert.equal(back.width, 37);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  }
});

test('decodes all filter types written by other encoders', () => {
  // Build a PNG by hand using filter types 0..4 on successive rows.
  const w = 4, h = 5;
  const img = gradient(w, h);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    const row = Buffer.alloc(1 + w * 4);
    row[0] = f;
    for (let x = 0; x < w * 4; x++) {
      const cur = img.data[y * w * 4 + x];
      const a = x >= 4 ? img.data[y * w * 4 + x - 4] : 0;
      const b = y > 0 ? img.data[(y - 1) * w * 4 + x] : 0;
      const c = x >= 4 && y > 0 ? img.data[(y - 1) * w * 4 + x - 4] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[1 + x] = (cur - pred) & 0xff;
    }
    rows.push(row);
  }
  const ref = encodePng(img);
  // splice: replace IDAT of a reference PNG with our hand-filtered data
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const ihdrEnd = 8 + 25;
  const len = Buffer.alloc(4); len.writeUInt32BE(idat.length);
  const type = Buffer.from('IDAT');
  const crcBuf = Buffer.alloc(4); // CRC is not verified by our decoder
  const ihdr = Buffer.from(ref.subarray(0, ihdrEnd));
  ihdr[8 + 8 + 9] = 6; // color type RGBA
  const png = Buffer.concat([ihdr, len, type, idat, crcBuf, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
  const back = decodePng(png);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
});

test('crop clamps to bounds', () => {
  const img = gradient(10, 10);
  const c = crop(img, { x: 8, y: 8, width: 5, height: 5 });
  assert.equal(c.width, 2);
  assert.equal(c.height, 2);
  assert.equal(c.data[0], img.data[(8 * 10 + 8) * 4]);
});

test('resize down and up', () => {
  const img = gradient(100, 50);
  const small = resize(img, 25, 12);
  assert.equal(small.width, 25);
  assert.equal(small.height, 12);
  const big = resize(img, 200, 100);
  assert.equal(big.data.length, 200 * 100 * 4);
});

test('fingerprint diff detects change', () => {
  const a = gradient(64, 64);
  const b = gradient(64, 64);
  assert.equal(diffFingerprints(fingerprint(a), fingerprint(b)), 0);
  for (let i = 0; i < b.data.length / 2; i += 4) { b.data[i] = 255 - b.data[i]; b.data[i + 1] = 255; }
  assert.ok(diffFingerprints(fingerprint(a), fingerprint(b)) > 0.2);
});

test('decodes a 32bpp XWD dump', () => {
  const w = 3, h = 2, header = 100;
  const buf = Buffer.alloc(header + w * h * 4);
  const fields = { 0: header, 4: 7, 8: 2, 16: w, 20: h, 28: 0, 44: 32, 48: w * 4, 56: 0xff0000, 60: 0x00ff00, 64: 0x0000ff, 76: 0 };
  for (const [o, v] of Object.entries(fields)) buf.writeUInt32BE(v, Number(o));
  for (let i = 0; i < w * h; i++) buf.writeUInt32LE((10 * i) << 16 | (20 + i) << 8 | (30 + i), header + i * 4);
  const img = decodeXwd(buf);
  assert.equal(img.width, 3);
  assert.deepEqual([...img.data.slice(4, 8)], [10, 21, 31, 255]);
});
