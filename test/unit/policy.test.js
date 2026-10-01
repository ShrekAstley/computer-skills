import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { SafetyPolicy, DECISIONS } from '../../src/safety/policy.js';
import { DEFAULT_CONFIG, applyProjectConfig, loadConfig, normalizeLevel } from '../../src/core/config.js';
import { deepMerge } from '../../src/core/util.js';
import { tmpDir } from '../helpers.js';

const mk = (level, extra = {}) => {
  const dir = tmpDir();
  const config = deepMerge(DEFAULT_CONFIG, { safety: { level, ...extra } });
  let t = 1_000_000;
  const p = new SafetyPolicy({ config, auditFile: path.join(dir, 'audit.jsonl'), stopFile: path.join(dir, 'STOP'), now: () => t });
  p.advance = (ms) => (t += ms);
  p.dir = dir;
  return p;
};
const A = (risk) => ({ risk, reasons: ['r'], categories: ['c'] });

test('decision matrix', () => {
  assert.equal(DECISIONS.restricted.safe, 'allow');
  assert.equal(DECISIONS.restricted.low, 'confirm');
  assert.equal(DECISIONS.restricted.high, 'deny');
  assert.equal(DECISIONS.normal.medium, 'allow');
  assert.equal(DECISIONS.normal.high, 'confirm');
  assert.equal(DECISIONS.trusted.high, 'allow');
  assert.equal(DECISIONS.trusted.critical, 'confirm');
  for (const l of Object.keys(DECISIONS)) assert.equal(DECISIONS[l].forbidden, 'deny');
});

test('allow, deny, and token confirmation flow', async () => {
  const p = mk('normal');
  assert.deepEqual(await p.enforce({ tool: 't', args: { a: 1 }, assessment: A('medium'), summary: 's' }), { decision: 'allow' });
  await assert.rejects(p.enforce({ tool: 't', args: {}, assessment: A('forbidden'), summary: 's' }), { code: 'POLICY_DENIED' });
  let token;
  await assert.rejects(p.enforce({ tool: 't', args: { a: 1 }, assessment: A('high'), summary: 's' }), (e) => {
    token = e.details.confirm_token;
    return e.code === 'CONFIRMATION_REQUIRED' && !!token;
  });
  // token bound to the exact arguments
  await assert.rejects(p.enforce({ tool: 't', args: { a: 2, confirm: token }, assessment: A('high'), summary: 's' }), /different action/);
  // A failed attempt with mismatched args does not consume the token
  assert.deepEqual(await p.enforce({ tool: 't', args: { a: 1, confirm: token }, assessment: A('high'), summary: 's' }), { decision: 'confirmed' });
  // single use
  await assert.rejects(p.enforce({ tool: 't', args: { a: 1, confirm: token }, assessment: A('high'), summary: 's' }), /unknown or expired/);
});

test('tokens expire', async () => {
  const p = mk('normal', { confirmTtlSec: 10 });
  let token;
  await p.enforce({ tool: 't', args: {}, assessment: A('high'), summary: 's' }).catch((e) => (token = e.details.confirm_token));
  p.advance(11000);
  await assert.rejects(p.enforce({ tool: 't', args: { confirm: token }, assessment: A('high'), summary: 's' }), /expired/);
});

test('elicitation: accept, accept for session, decline, unsupported', async () => {
  const p = mk('normal');
  const base = { tool: 't', args: { x: 1 }, assessment: A('high'), summary: 's' };
  assert.deepEqual(await p.enforce({ ...base, elicit: async () => 'accept' }), { decision: 'confirmed' });
  await assert.rejects(p.enforce({ ...base, elicit: async () => 'decline' }), (e) => e.code === 'POLICY_DENIED' && /declined/.test(e.message));
  await assert.rejects(p.enforce({ ...base, elicit: async () => 'unsupported' }), { code: 'CONFIRMATION_REQUIRED' });
  await p.enforce({ ...base, elicit: async () => 'accept_session' });
  assert.deepEqual(await p.enforce({ ...base }), { decision: 'confirmed' }, 'session approval reused for the identical action');
  await assert.rejects(p.enforce({ ...base, args: { x: 2 } }), { code: 'CONFIRMATION_REQUIRED' });
});

test('restricted level denies high risk even with elicitation', async () => {
  const p = mk('restricted');
  await assert.rejects(p.enforce({ tool: 't', args: {}, assessment: A('high'), summary: 's', elicit: async () => 'accept' }), { code: 'POLICY_DENIED' });
});

test('kill switch and audit log', async () => {
  const p = mk('normal');
  assert.equal(p.isStopped(), false);
  p.setStopped(true, 'test');
  assert.equal(p.isStopped(), true);
  p.setStopped(false);
  assert.equal(p.isStopped(), false);
  await p.enforce({ tool: 'x', args: {}, assessment: A('low'), summary: 'hello' });
  await new Promise((r) => setTimeout(r, 50));
  const log = fs.readFileSync(path.join(p.dir, 'audit.jsonl'), 'utf8');
  assert.match(log, /"decision":"allow"/);
});

test('project config can tighten but not loosen safety', () => {
  const user = deepMerge(DEFAULT_CONFIG, { safety: { level: 'normal' } });
  assert.equal(applyProjectConfig(user, { safety: { level: 'trusted', allowCommands: ['.*'] } }).safety.level, 'normal');
  assert.deepEqual(applyProjectConfig(user, { safety: { allowCommands: ['.*'] } }).safety.allowCommands, []);
  assert.equal(applyProjectConfig(user, { safety: { level: 'restricted' } }).safety.level, 'restricted');
  assert.deepEqual(applyProjectConfig(user, { safety: { denyCommands: ['^git push'] } }).safety.denyCommands, ['^git push']);
  const permissive = deepMerge(user, { safety: { allowProjectEscalation: true } });
  assert.equal(applyProjectConfig(permissive, { safety: { level: 'trusted' } }).safety.level, 'trusted');
});

test('loadConfig honours env and files', () => {
  const home = tmpDir();
  const proj = tmpDir();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ safety: { level: 'trusted' }, screen: { maxWidth: 1000 } }));
  fs.mkdirSync(path.join(proj, '.computer-skills'));
  fs.writeFileSync(path.join(proj, '.computer-skills', 'config.json'), JSON.stringify({ safety: { level: 'restricted' } }));
  const cfg = loadConfig({ COMPUTER_SKILLS_HOME: home, COMPUTER_SKILLS_PROJECT_DIR: proj });
  assert.equal(cfg.safety.level, 'restricted');
  assert.equal(cfg.screen.maxWidth, 1000);
  const cfg2 = loadConfig({ COMPUTER_SKILLS_HOME: home, COMPUTER_SKILLS_PROJECT_DIR: tmpDir(), COMPUTER_SKILLS_LEVEL: 'autonomous' });
  assert.equal(cfg2.safety.level, 'trusted');
  assert.equal(normalizeLevel('bogus'), undefined);
});
