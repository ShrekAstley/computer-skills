import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowStore, textScore } from '../../src/workflow/store.js';
import { validateWorkflow, normalizeWorkflow, substitute, resolveParams, unresolvedPlaceholders } from '../../src/workflow/schema.js';
import { confidence } from '../../src/workflow/confidence.js';
import { BUILTIN_WORKFLOWS } from '../../src/core/paths.js';
import { tmpDir } from '../helpers.js';

const sample = (over = {}) => ({
  name: 'Export PNG',
  app: { name: 'Blender', version: '>=4.0' },
  description: 'Render and export a png image',
  triggers: ['export png', 'render image'],
  parameters: [{ name: 'out', required: true }, { name: 'quality', default: 90 }],
  steps: [{ id: 's1', title: 'go', action: { tool: 'terminal_run', args: { command: 'echo {{out}} {{quality}}' } }, expect: [{ type: 'file_exists', path: '{{out}}' }] }],
  ...over,
});

const mkStore = () => {
  const home = tmpDir();
  return new WorkflowStore({ userDir: path.join(home, 'wf'), projectDir: path.join(home, 'proj'), builtinDir: path.join(home, 'builtin'), historyDir: path.join(home, 'hist') });
};

test('validation catches structural errors', () => {
  assert.throws(() => validateWorkflow({}), /name is required/);
  assert.throws(() => validateWorkflow(sample({ steps: [{ title: 'x' }] })), /needs "action"/);
  assert.throws(() => validateWorkflow(sample({ steps: [{ manual: 'x', expect: [{ type: 'nope' }] }] })), /Unknown check type/);
  assert.throws(() => validateWorkflow(sample({ steps: [{ manual: 'x', on_failure: 'explode' }] })), /on_failure/);
  assert.doesNotThrow(() => validateWorkflow(sample()));
});

test('normalisation assigns ids and defaults', () => {
  const wf = normalizeWorkflow(sample({ steps: [{ manual: 'do it' }] }));
  assert.equal(wf.id, 'blender/export-png');
  assert.equal(wf.steps[0].id, 'step-1');
  assert.equal(wf.stats.runs, 0);
});

test('parameter substitution keeps types and reports leftovers', () => {
  const p = resolveParams(normalizeWorkflow(sample()), { out: '/tmp/a.png' });
  assert.deepEqual(p, { out: '/tmp/a.png', quality: 90 });
  assert.deepEqual(substitute({ a: '{{quality}}', b: 'q={{quality}}', c: ['{{out}}'] }, p), { a: 90, b: 'q=90', c: ['/tmp/a.png'] });
  assert.throws(() => resolveParams(normalizeWorkflow(sample()), {}), /Missing workflow parameters: out/);
  assert.deepEqual(unresolvedPlaceholders({ x: 'a {{zz}}' }), ['zz']);
});

test('save, version, archive, restore, delete', async () => {
  const store = mkStore();
  const r1 = await store.save(sample());
  assert.deepEqual([r1.id, r1.version, r1.created], ['blender/export-png', 1, true]);
  const r2 = await store.save(sample({ description: 'v2' }), { changeNote: 'better', verified: true });
  assert.equal(r2.version, 2);
  const wf = await store.get('blender/export-png');
  assert.equal(wf.description, 'v2');
  assert.equal(wf.stats.successes, 1);
  assert.ok(wf.stats.last_verified);
  assert.equal(wf.history.at(-1).change, 'better');
  const v = await store.versions('blender/export-png');
  assert.deepEqual(v.archived, [1]);
  const r3 = await store.restore('blender/export-png', 1);
  assert.equal(r3.version, 3);
  assert.equal((await store.get('blender/export-png')).description, 'Render and export a png image');
  await store.remove('blender/export-png');
  await assert.rejects(store.get('blender/export-png'), /No workflow/);
});

test('merge updates only given fields', async () => {
  const store = mkStore();
  await store.save(sample());
  await store.save({ id: 'blender/export-png', notes: ['tip'] }, { merge: true });
  const wf = await store.get('blender/export-png');
  assert.deepEqual(wf.notes, ['tip']);
  assert.equal(wf.steps.length, 1);
});

test('search ranks by relevance and classifies status', async () => {
  const store = mkStore();
  await store.save(sample(), { verified: true });
  await store.save(sample({ name: 'Import OBJ', triggers: ['import obj model'], description: 'import a mesh' }));
  let r = await store.search({ query: 'export a png', os: 'linux' });
  assert.equal(r.results[0].id, 'blender/export-png');
  assert.equal(r.status, 'known');
  r = await store.search({ query: 'import obj' });
  assert.equal(r.results[0].id, 'blender/import-obj');
  assert.equal(r.status, 'partial', 'never verified');
  r = await store.search({ query: 'send an email with outlook' });
  assert.equal(r.status, 'unknown');
  r = await store.search({ app: 'blender' });
  assert.equal(r.results.length, 2);
  assert.ok(textScore('exprot png', normalizeWorkflow(sample())) > 0.5, 'typo tolerant');
});

test('outcomes update reliability; failures degrade it', async () => {
  const store = mkStore();
  await store.save(sample(), { verified: true });
  let r = await store.recordOutcome('blender/export-png', { success: false, reason: 'button moved', step: 's1' });
  assert.equal(r.status, 'partial');
  assert.match(r.reasons.join(' '), /most recent run failed: step s1: button moved/);
  r = await store.recordOutcome('blender/export-png', { success: true, appVersion: '4.2.0' });
  const wf = await store.get('blender/export-png');
  assert.equal(wf.stats.runs, 3);
  assert.equal(wf.app.tested_version, '4.2.0');
});

test('builtin workflows keep stats in an overlay instead of being copied', async () => {
  const store = mkStore();
  const b = store.dirs.find((d) => d.scope === 'builtin').dir;
  fs.mkdirSync(path.join(b, 'blender'), { recursive: true });
  fs.writeFileSync(path.join(b, 'blender', 'export-png.json'), JSON.stringify(sample({ source: 'builtin' })));
  await store.recordOutcome('blender/export-png', { success: true });
  const wf = await store.get('blender/export-png');
  assert.equal(wf._scope, 'builtin');
  assert.equal(wf.stats.successes, 1);
  assert.equal(fs.existsSync(path.join(store.userDir, 'blender', 'export-png.json')), false);
  // Explicitly saving creates a user override with a higher version
  const r = await store.save({ ...sample(), description: 'mine' });
  assert.equal(r.version, 2);
  assert.equal((await store.get('blender/export-png'))._scope, 'user');
});

test('project scope wins over user scope', async () => {
  const store = mkStore();
  await store.save(sample({ description: 'user' }));
  await store.save(sample({ description: 'project' }), { scope: 'project' });
  assert.equal((await store.get('blender/export-png')).description, 'project');
});

test('confidence model', () => {
  const now = Date.parse('2026-10-01');
  const base = normalizeWorkflow(sample());
  assert.equal(confidence(base, { now }).status, 'partial');
  const ok = { ...base, platforms: ['linux'], stats: { ...base.stats, runs: 3, successes: 3, last_success: '2026-09-30', last_verified: '2026-09-30' } };
  assert.equal(confidence(ok, { now, os: 'linux' }).status, 'known');
  assert.equal(confidence(ok, { now, os: 'windows' }).status, 'partial');
  assert.ok(confidence(ok, { now: Date.parse('2027-06-01') }).confidence < confidence(ok, { now }).confidence, 'stale');
  assert.equal(confidence(ok, { now, appVersion: '3.6' }).status, 'partial', 'outside version range');
});

test('every built-in example workflow is valid', async () => {
  const store = new WorkflowStore({ userDir: tmpDir(), builtinDir: BUILTIN_WORKFLOWS, historyDir: tmpDir() });
  const all = await store.loadAll({ fresh: true });
  assert.deepEqual(store.problems, []);
  assert.ok(all.size >= 6);
  assert.ok(all.has('blender/create-terrain-scene'));
});
