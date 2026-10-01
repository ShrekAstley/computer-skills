import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeRuntime, FakeBackend, call, tmpDir } from '../helpers.js';

const writeCmd = (file, text = 'ok') => `node -e "require('fs').writeFileSync(process.argv[1], '${text}')" "${file.replace(/\\/g, '\\\\')}"`;

test('runs steps, verifies expectations and records success', async () => {
  const rt = await fakeRuntime();
  const dir = tmpDir();
  await call(rt, 'workflow_save', {
    workflow: {
      name: 'Write file',
      app: 'Shell',
      parameters: [{ name: 'out', required: true }],
      steps: [{ id: 'write', action: { tool: 'terminal_run', args: { command: writeCmd('{{out}}') } }, expect: [{ type: 'file_exists', path: '{{out}}', modified_after_start: true }] }],
      expected_results: [{ type: 'file_contains', path: '{{out}}', text: 'ok' }],
    },
  });
  const out = path.join(dir, 'a.txt');
  const r = await call(rt, 'workflow_run', { id: 'shell/write-file', params: { out } });
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(r.steps[0].verified, true);
  assert.equal(r.stats.status, 'known');
  const dry = await call(rt, 'workflow_run', { id: 'shell/write-file', params: { out: '/x' }, dry_run: true });
  assert.equal(dry.status, 'dry_run');
  assert.match(dry.steps[0].action.args.command, /\/x/);
});

test('failing step stops with diagnosis, recovery guide and recorded failure', async () => {
  const rt = await fakeRuntime();
  await call(rt, 'workflow_save', {
    workflow: {
      name: 'Never works',
      app: 'Shell',
      steps: [
        { id: 'a', action: { tool: 'terminal_run', args: { command: 'echo step-a' } } },
        { id: 'b', action: { tool: 'terminal_run', args: { command: 'echo nothing' } }, expect: [{ type: 'file_exists', path: path.join(tmpDir(), 'missing') }], timeout_ms: 200, retries: 1 },
        { id: 'c', action: { tool: 'terminal_run', args: { command: 'echo never' } } },
      ],
      failure_modes: [{ symptom: 'file missing', recovery: 'do something else' }],
    },
  });
  const r = await call(rt, 'workflow_run', { id: 'shell/never-works' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failed_step, 'b');
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].attempts, 2);
  assert.ok(r.diagnosis.observations.length);
  assert.equal(r.recovery_guide.known_failure_modes[0].recovery, 'do something else');
  assert.equal(r.stats.status, 'partial');
  const wf = await call(rt, 'workflow_get', { id: 'shell/never-works' });
  assert.equal(wf.stats.failures, 1);
  assert.match(wf.stats.last_failure_reason, /step b/);
});

test('non-zero exit fails the step even without expectations', async () => {
  const rt = await fakeRuntime();
  await call(rt, 'workflow_save', { workflow: { name: 'Exit one', app: 'Shell', steps: [{ id: 'x', action: { tool: 'terminal_run', args: { command: 'exit 1' } } }] } });
  const r = await call(rt, 'workflow_run', { id: 'shell/exit-one' });
  assert.equal(r.status, 'failed');
  assert.match(r.error.message, /exit code 1/);
});

test('manual steps pause and resume with verification', async () => {
  const rt = await fakeRuntime();
  const file = path.join(tmpDir(), 'manual.txt');
  await call(rt, 'workflow_save', {
    workflow: {
      name: 'Has manual',
      app: 'Shell',
      steps: [
        { id: 'auto', action: { tool: 'terminal_run', args: { command: 'echo 1' } } },
        { id: 'human', manual: 'Create the file', expect: [{ type: 'file_exists', path: file }], timeout_ms: 100 },
        { id: 'after', action: { tool: 'terminal_run', args: { command: 'echo 3' } } },
      ],
    },
  });
  const r = await call(rt, 'workflow_run', { id: 'shell/has-manual' });
  assert.equal(r.status, 'paused');
  assert.equal(r.manual_step.id, 'human');
  assert.deepEqual(r.resume, { start_at: 'after' });
  const notYet = await call(rt, 'workflow_run', { id: 'shell/has-manual', start_at: 'after' });
  assert.equal(notYet.status, 'failed');
  assert.equal(notYet.failed_step, 'human');
  fs.writeFileSync(file, 'x');
  const done = await call(rt, 'workflow_run', { id: 'shell/has-manual', start_at: 'after' });
  assert.equal(done.status, 'succeeded');
  assert.match(done.note, /workflow_feedback/);
});

test('steps needing approval block instead of failing', async () => {
  const rt = await fakeRuntime();
  await call(rt, 'workflow_save', { workflow: { name: 'Risky', app: 'Shell', steps: [{ id: 'r', action: { tool: 'terminal_run', args: { command: 'sudo true' } } }] } });
  const r = await call(rt, 'workflow_run', { id: 'shell/risky' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.error.code, 'CONFIRMATION_REQUIRED');
  const wf = await call(rt, 'workflow_get', { id: 'shell/risky' });
  assert.equal(wf.stats.failures, 0, 'blocked runs do not count as workflow failures');
});

test('preconditions are checked first', async () => {
  const rt = await fakeRuntime();
  await call(rt, 'workflow_save', { workflow: { name: 'Needs window', app: 'Shell', preconditions: [{ type: 'window_exists', title: 'Blender' }], steps: [{ action: { tool: 'terminal_run', args: { command: 'echo' } } }] } });
  const r = await call(rt, 'workflow_run', { id: 'shell/needs-window' });
  assert.equal(r.status, 'precondition_failed');
});

test('recorder turns actions into a draft with durable targets', async () => {
  const backend = new FakeBackend({
    windows: [{ id: 'w', title: 'App', app: 'app', pid: 9, x: 0, y: 0, width: 200, height: 100, focused: true }],
    a11y: [{ role: 'push button', name: 'Export', x: 10, y: 10, width: 40, height: 20, ref: { id: 'btn' } }],
  });
  const rt = await fakeRuntime({ backend });
  const outer = (name, args) => rt.host.invoke(name, args, { via: 'client' });
  await outer('workflow_record', { action: 'start', name: 'Export thing', app: 'App' });
  const f = await outer('ui_find', { text: 'Export' });
  await outer('ui_action', { action: 'press', element: f.matches[0].el });
  await outer('verify', { checks: [{ type: 'window_exists', title: 'App' }] });
  await outer('input_keyboard', { action: 'press', keys: 'enter' });
  await outer('input_mouse', { action: 'click', x: 3, y: 4 });
  await outer('terminal_run', { command: 'exit 3' }).catch(() => {});
  await outer('window', { action: 'list' });
  const { draft, warnings } = await outer('workflow_record', { action: 'stop' });
  assert.equal(draft.steps.length, 4, JSON.stringify(draft.steps));
  assert.deepEqual(draft.steps[0].action, { tool: 'ui_action', args: { action: 'press', text: 'Export', role: 'push button' } });
  assert.equal(draft.steps[0].expect[0].type, 'window_exists');
  assert.ok(warnings.some((w) => /raw coordinates/.test(w)));
  const saved = await outer('workflow_save', { workflow: draft, verified: true });
  assert.equal(saved.id, 'app/export-thing');
});
