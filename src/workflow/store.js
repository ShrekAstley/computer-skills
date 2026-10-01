import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, listFiles, ensureDir } from '../core/fsutil.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { normalizeWorkflow, validateWorkflow, normalizeApp } from './schema.js';
import { confidence } from './confidence.js';
import { normText, similarity, nowIso, deepMerge } from '../core/util.js';

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'in', 'into', 'of', 'and', 'or', 'for', 'with', 'on', 'as', 'my', 'this', 'that', 'it', 'from', 'then', 'using', 'use', 'how', 'do', 'i', 'please']);
const SCOPE_RANK = { project: 4, user: 3, extra: 2, builtin: 1 };

export function tokens(text) {
  return normText(text).split(/[\s/._-]+/).filter((t) => t && !STOPWORDS.has(t));
}

/** Relevance of a workflow to a free-text query, 0..1. */
export function textScore(query, wf) {
  const q = tokens(query);
  if (!q.length) return 0;
  const fields = [
    [tokens(wf.name), 1],
    [tokens((wf.triggers || []).join(' ')), 1],
    [tokens((wf.tags || []).join(' ')), 0.8],
    [tokens(`${wf.app?.name ?? ''} ${wf.app?.id ?? ''}`), 0.9],
    [tokens(wf.description || ''), 0.6],
  ];
  let total = 0;
  for (const t of q) {
    let best = 0;
    for (const [toks, weight] of fields) {
      for (const d of toks) {
        let s = 0;
        if (d === t) s = 1;
        else if (d.startsWith(t) || t.startsWith(d)) s = Math.min(t.length, d.length) >= 3 ? 0.8 : 0;
        else if (t.length > 3 && d.length > 3) {
          const sim = similarity(t, d);
          if (sim >= 0.8) s = sim * 0.8;
        }
        best = Math.max(best, s * weight);
      }
    }
    total += best;
  }
  let score = total / q.length;
  const nq = normText(query);
  if ((wf.triggers || []).some((tr) => normText(tr) === nq) || normText(wf.name) === nq) score = Math.min(1, score + 0.2);
  return Math.round(score * 100) / 100;
}

/**
 * Persistent workflow memory. Workflows are JSON files, one per workflow,
 * grouped by app: <dir>/<app>/<task>.json. Every update archives the previous
 * version under .history so changes can be audited and rolled back.
 */
export class WorkflowStore {
  /**
   * @param {{userDir: string, projectDir?: string, extraDirs?: string[], builtinDir?: string, historyDir: string, config?: object}} opts
   */
  constructor({ userDir, projectDir, extraDirs = [], builtinDir, historyDir, config }) {
    this.dirs = [
      ...(projectDir ? [{ scope: 'project', dir: projectDir, writable: true }] : []),
      { scope: 'user', dir: userDir, writable: true },
      ...extraDirs.map((d) => ({ scope: 'extra', dir: d, writable: false })),
      ...(builtinDir ? [{ scope: 'builtin', dir: builtinDir, writable: false }] : []),
    ];
    this.userDir = userDir;
    this.projectDir = projectDir;
    this.historyDir = historyDir;
    this.config = config;
    this.cache = null;
    this.cacheAt = 0;
  }

  invalidate() {
    this.cache = null;
  }

  async loadAll({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cacheAt < 2000) return this.cache;
    const byId = new Map();
    const problems = [];
    for (const { scope, dir } of this.dirs) {
      for (const file of await listFiles(dir, '.json')) {
        let wf;
        try {
          wf = normalizeWorkflow(validateWorkflow(await readJson(file)));
        } catch (err) {
          problems.push({ file, error: err.message });
          continue;
        }
        if (scope === 'builtin' || scope === 'extra') {
          // Read-only workflows keep their run statistics in a separate overlay.
          const overlay = await readJson(this._overlayFile(wf.id), null).catch(() => null);
          if (overlay) {
            wf.stats = { ...wf.stats, ...overlay.stats };
            if (overlay.tested_version) wf.app = { ...wf.app, tested_version: overlay.tested_version };
            if (overlay.platforms) wf.platforms = [...new Set([...wf.platforms, ...overlay.platforms])];
          }
        }
        const prev = byId.get(wf.id);
        if (!prev || SCOPE_RANK[scope] > SCOPE_RANK[prev._scope]) {
          Object.defineProperty(wf, '_scope', { value: scope, enumerable: false });
          Object.defineProperty(wf, '_file', { value: file, enumerable: false });
          byId.set(wf.id, wf);
        }
      }
    }
    this.cache = byId;
    this.cacheAt = Date.now();
    this.problems = problems;
    return byId;
  }

  async get(id) {
    const all = await this.loadAll();
    const wf = all.get(id);
    if (!wf) {
      const near = [...all.keys()].filter((k) => k.includes(id.split('/').pop() ?? id)).slice(0, 5);
      throw new ToolError(ErrorCode.NOT_FOUND, `No workflow "${id}"`, { hint: near.length ? `Did you mean: ${near.join(', ')}?` : 'Use workflow_search to find workflows.' });
    }
    return wf;
  }

  /**
   * @returns {Promise<{status: 'known'|'partial'|'unknown', results: object[]}>}
   */
  async search({ query = '', app, os, appVersion, limit = 5, minScore = 0.35 }) {
    const all = await this.loadAll();
    const appId = app ? normalizeApp(app).id : null;
    const results = [];
    for (const wf of all.values()) {
      if (appId && wf.app.id !== appId && !normText(wf.app.name).includes(normText(app))) continue;
      const rel = query ? textScore(query, wf) : appId ? 0.5 : 0;
      if (query && rel < minScore) continue;
      const conf = confidence(wf, { os, appVersion, staleAfterDays: this.config?.workflows?.staleAfterDays ?? 90 });
      results.push({ wf, rel, conf, score: rel * 0.75 + conf.confidence * 0.25 });
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit).map(({ wf, rel, conf }) => ({
      id: wf.id,
      name: wf.name,
      app: wf.app.name,
      app_version: wf.app.version ?? wf.app.tested_version,
      description: wf.description,
      relevance: rel,
      confidence: conf.confidence,
      status: conf.status,
      reasons: conf.reasons.length ? conf.reasons : undefined,
      parameters: wf.parameters.map((p) => p.name),
      steps: wf.steps.length,
      last_verified: wf.stats.last_verified,
      runs: wf.stats.runs,
      version: wf.version,
      scope: wf._scope,
    }));
    let status = 'unknown';
    const best = top[0];
    if (best && (!query || best.relevance >= 0.6)) status = best.status;
    else if (best) status = 'partial';
    return { status, results: top };
  }

  _targetDir(scope) {
    if (scope === 'project') {
      if (!this.projectDir) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'No project directory configured');
      return this.projectDir;
    }
    return this.userDir;
  }

  _overlayFile(id) {
    const [app, task] = id.split('/');
    return path.join(this.userDir, '.stats', app, `${task}.json`);
  }

  _fileFor(dir, id) {
    const [app, task] = id.split('/');
    return path.join(dir, app, `${task}.json`);
  }

  async _archive(wf) {
    const [app, task] = wf.id.split('/');
    const file = path.join(this.historyDir, app, task, `v${wf.version}.json`);
    await ensureDir(path.dirname(file));
    await writeJsonAtomic(file, wf);
    return file;
  }

  /**
   * Create or update a workflow. Updates bump the version and archive the old one.
   * @param {object} input workflow document (may omit stats/history)
   * @param {{scope?: 'user'|'project', changeNote?: string, verified?: boolean, resetStats?: boolean, merge?: boolean}} opts
   */
  async save(input, { scope = 'user', changeNote, verified = false, resetStats = false, merge = false } = {}) {
    const all = await this.loadAll({ fresh: true });
    let draft = input;
    const candidateId = input.id ?? normalizeWorkflow({ ...input, steps: input.steps ?? [{ manual: 'x' }] }).id;
    const existing = all.get(candidateId);
    if (merge && existing) draft = deepMerge(stripMeta(existing), input);
    validateWorkflow(draft);
    const wf = normalizeWorkflow({ ...draft, id: candidateId });
    const now = nowIso();
    if (existing) {
      if (existing._scope === 'user' || existing._scope === 'project') await this._archive(existing);
      wf.version = (existing.version || 1) + 1;
      wf.created = existing.created;
      wf.history = [...(existing.history || []), { version: wf.version, date: now, change: changeNote || 'updated', previous_scope: existing._scope }].slice(-50);
      wf.stats = resetStats ? normalizeWorkflow({ ...wf, stats: undefined }).stats : { ...existing.stats };
      if (existing._scope === 'builtin' && wf.source === 'builtin') wf.source = 'learned';
    } else {
      wf.version = 1;
      wf.history = [{ version: 1, date: now, change: changeNote || 'created' }];
    }
    wf.updated = now;
    if (verified) {
      wf.stats.runs += 1;
      wf.stats.successes += 1;
      wf.stats.last_success = now;
      wf.stats.last_verified = now;
    }
    const file = this._fileFor(this._targetDir(scope), wf.id);
    await writeJsonAtomic(file, stripMeta(wf));
    this.invalidate();
    return { id: wf.id, version: wf.version, file, created: !existing, scope };
  }

  /** Record the outcome of a run (also used automatically by workflow_run). */
  async recordOutcome(id, { success, reason, step, appVersion, os, durationMs }) {
    const wf = await this.get(id);
    const now = nowIso();
    const updated = { ...stripMeta(wf), stats: { ...wf.stats } };
    updated.stats.runs += 1;
    if (success) {
      updated.stats.successes += 1;
      updated.stats.last_success = now;
      updated.stats.last_verified = now;
      if (appVersion) updated.app = { ...updated.app, tested_version: appVersion };
      if (os && !updated.platforms.includes(os)) updated.platforms = [...updated.platforms, os];
      if (durationMs) updated.stats.last_duration_ms = durationMs;
    } else {
      updated.stats.failures += 1;
      updated.stats.last_failure = now;
      updated.stats.last_failure_reason = [step ? `step ${step}` : null, reason].filter(Boolean).join(': ').slice(0, 300) || 'unspecified';
    }
    if (wf._scope === 'builtin' || wf._scope === 'extra') {
      // Never copy read-only workflows (that would shadow future package updates); keep stats aside.
      await writeJsonAtomic(this._overlayFile(wf.id), { id: wf.id, stats: updated.stats, tested_version: updated.app.tested_version, platforms: updated.platforms });
    } else {
      await writeJsonAtomic(wf._file, updated);
    }
    this.invalidate();
    return { id, stats: updated.stats, ...confidence(updated, { os }) };
  }

  async versions(id) {
    const [app, task] = id.split('/');
    const dir = path.join(this.historyDir, app ?? '', task ?? '');
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => /^v\d+\.json$/.test(f));
    } catch {
      /* none */
    }
    const current = await this.get(id).catch(() => null);
    return {
      id,
      current_version: current?.version,
      history: current?.history ?? [],
      archived: files.map((f) => Number(f.slice(1, -5))).sort((a, b) => a - b),
    };
  }

  async restore(id, version) {
    const [app, task] = id.split('/');
    const file = path.join(this.historyDir, app, task, `v${version}.json`);
    const old = await readJson(file).catch(() => null);
    if (!old) throw new ToolError(ErrorCode.NOT_FOUND, `No archived version ${version} of ${id}`);
    return this.save({ ...old, id }, { changeNote: `restored version ${version}` });
  }

  async remove(id) {
    const wf = await this.get(id);
    if (wf._scope !== 'user' && wf._scope !== 'project') throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Workflow ${id} is ${wf._scope} (read-only)`);
    await this._archive(wf);
    await fsp.rm(wf._file, { force: true });
    this.invalidate();
    return { id, removed: true, archived_version: wf.version };
  }
}

function stripMeta(wf) {
  const { _scope, _file, ...rest } = wf;
  return JSON.parse(JSON.stringify(rest));
}
