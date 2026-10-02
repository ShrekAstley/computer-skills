import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (err instanceof SyntaxError) {
      err.message = `Invalid JSON in ${file}: ${err.message}`;
    }
    throw err;
  }
}

export function readJsonSync(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

/**
 * Atomic write: write to a sibling temp file, then rename over the target, so a
 * crash never leaves a half-written workflow or config behind.
 */
export async function writeFileAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // Windows can refuse to rename over a file that is open elsewhere; fall back to copy.
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      await fsp.copyFile(tmp, file);
      await fsp.rm(tmp, { force: true });
    } else {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function appendLine(file, line) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, line.endsWith('\n') ? line : line + '\n');
}

/** Recursively list files with a given extension (skips dot-directories). */
export async function listFiles(dir, ext) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!ext || e.name.endsWith(ext)) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

/** Keep only the newest `keep` files in a directory. */
export async function pruneDir(dir, keep) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const stats = await Promise.all(
    entries.map(async (name) => {
      const p = path.join(dir, name);
      try {
        const s = await fsp.stat(p);
        return s.isFile() ? { p, t: s.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  const files = stats.filter(Boolean).sort((a, b) => b.t - a.t);
  const doomed = files.slice(keep);
  await Promise.all(doomed.map((f) => fsp.rm(f.p, { force: true })));
  return doomed.length;
}
