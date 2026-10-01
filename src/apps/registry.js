import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blender from './adapters/blender.js';
import { chrome, chromium, edge, firefox } from './adapters/browser.js';
import { vscode, godot, unity, robloxStudio, photoshop, fileManager, terminalApp } from './adapters/dev-tools.js';
import { which } from '../core/exec.js';
import { expandPath } from '../core/paths.js';
import { matchScore, normText } from '../core/util.js';
import { osName } from '../platform/index.js';
import { defineAdapter } from './adapter.js';

export const BUILTIN_ADAPTERS = [blender, chrome, chromium, edge, firefox, vscode, godot, unity, robloxStudio, photoshop, fileManager, terminalApp];

/**
 * Registry of application adapters. Users can add adapters without touching
 * this package by dropping `*.js` modules into ~/.computer-skills/adapters
 * (each default-exporting a defineAdapter(...) object).
 */
export class AdapterRegistry {
  constructor(adapters = BUILTIN_ADAPTERS) {
    this.adapters = new Map();
    for (const a of adapters) this.register(a);
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
  }

  async loadUserAdapters(dir, logger) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of files) {
      try {
        const mod = await import(new URL(`file://${path.resolve(dir, f).replace(/\\/g, '/')}`).href);
        const list = mod.default ? [mod.default] : Object.values(mod);
        for (const a of list) if (a && a.id && a.name) {
          this.register(defineAdapter(a));
          n++;
        }
      } catch (err) {
        logger?.warn?.('failed to load adapter', { file: f, error: err.message });
      }
    }
    return n;
  }

  list() {
    return [...this.adapters.values()];
  }

  get(id) {
    return this.adapters.get(id) ?? null;
  }

  /** Find the adapter that best matches a free-text app name. */
  match(name) {
    if (!name) return null;
    const n = normText(name);
    let best = null;
    let bestScore = 0;
    for (const a of this.adapters.values()) {
      for (const cand of [a.id, a.name, ...a.aliases]) {
        const s = matchScore(n, cand, {});
        if (s > bestScore) {
          bestScore = s;
          best = a;
        }
      }
    }
    return bestScore >= 0.8 ? best : null;
  }

  /** Resolve an adapter's executable on this machine (PATH, known paths, globs). */
  findExecutable(adapter, platform = process.platform) {
    const loc = adapter.locate?.[osName(platform)];
    if (!loc) return null;
    for (const exe of loc.executables || []) {
      const p = which(exe);
      if (p) return p;
    }
    for (const raw of loc.paths || []) {
      for (const p of expandGlob(expandPath(raw))) {
        try {
          if (fs.statSync(p)) return p;
        } catch {
          /* missing */
        }
      }
    }
    if (platform === 'darwin') {
      for (const b of loc.bundleNames || []) {
        for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
          const bundle = path.join(dir, b);
          if (fs.existsSync(bundle)) {
            const macos = path.join(bundle, 'Contents', 'MacOS');
            try {
              const bin = fs.readdirSync(macos)[0];
              if (bin) return path.join(macos, bin);
            } catch {
              return bundle;
            }
          }
        }
      }
    }
    return null;
  }
}

/** Minimal glob for "*" path segments (e.g. C:/Program Files/Blender Foundation/*\/blender.exe). */
export function expandGlob(pattern) {
  const norm = pattern.replace(/\\/g, '/');
  if (!norm.includes('*')) return [pattern];
  const parts = norm.split('/');
  let bases = [parts[0] === '' ? '/' : parts[0] + (parts[0].endsWith(':') ? '/' : '')];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const next = [];
    for (const b of bases) {
      if (part.includes('*')) {
        const re = new RegExp('^' + part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
        let entries = [];
        try {
          entries = fs.readdirSync(b);
        } catch {
          continue;
        }
        for (const e of entries.sort().reverse()) if (re.test(e)) next.push(path.join(b, e)); // newest version first
      } else next.push(path.join(b, part));
    }
    bases = next;
    if (!bases.length) break;
  }
  return bases;
}
