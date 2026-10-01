import path from 'node:path';
import { readJson, writeJsonAtomic, listFiles } from '../core/fsutil.js';
import { slugify } from '../core/paths.js';
import { deepMerge, nowIso } from '../core/util.js';

/**
 * App profiles: what the agent has learned about an application in general
 * (independent of any single task) — where things are, shortcuts that work,
 * menus it explored, quirks, version seen. Merged with adapter knowledge on read.
 *
 * {
 *   "app": "Blender", "id": "blender",
 *   "versions_seen": {"4.2.1": "2026-09-30"},
 *   "executables": {"linux": "/usr/bin/blender"},
 *   "ui_map": {"render button": {"location": "top menu Render > Render Image", "how": "F12"}},
 *   "shortcuts": {"render": "f12"},
 *   "menus": {"File": ["New", "Open...", ...]},
 *   "quirks": ["UI is not accessible; use OCR"],
 *   "notes": [...], "updated": "..."
 * }
 */
export class AppProfiles {
  constructor({ dir, adapters }) {
    this.dir = dir;
    this.adapters = adapters;
  }

  file(app) {
    return path.join(this.dir, `${slugify(app)}.json`);
  }

  async get(app) {
    const adapter = this.adapters?.match(app);
    const id = adapter?.id ?? slugify(app);
    const learned = await readJson(this.file(id), null);
    const out = { app: adapter?.name ?? learned?.app ?? app, id };
    if (learned) out.learned = learned;
    if (adapter) {
      out.adapter = {
        id: adapter.id,
        scripting: adapter.scripting ? { language: adapter.scripting.language, description: adapter.scripting.description } : undefined,
        knowledge: adapter.knowledge,
      };
    }
    out.known = !!(learned || adapter);
    return out;
  }

  async update(app, patch, { appendLists = true } = {}) {
    const adapter = this.adapters?.match(app);
    const id = adapter?.id ?? slugify(app);
    const file = this.file(id);
    const current = (await readJson(file, null)) ?? { app: adapter?.name ?? app, id, created: nowIso() };
    let next = deepMerge(current, patch);
    if (appendLists) {
      for (const key of ['quirks', 'notes']) {
        if (Array.isArray(patch[key]) && Array.isArray(current[key])) next[key] = [...new Set([...current[key], ...patch[key]])].slice(-100);
      }
    }
    if (patch.version) next.versions_seen = { ...(current.versions_seen || {}), [patch.version]: nowIso().slice(0, 10) };
    delete next.version;
    next.updated = nowIso();
    await writeJsonAtomic(file, next);
    return { id, file, profile: next };
  }

  async list() {
    const files = await listFiles(this.dir, '.json');
    const out = [];
    for (const f of files) {
      const p = await readJson(f, null).catch(() => null);
      if (p) out.push({ id: p.id ?? path.basename(f, '.json'), app: p.app, updated: p.updated, entries: Object.keys(p.ui_map || {}).length + Object.keys(p.shortcuts || {}).length });
    }
    return out;
  }
}
