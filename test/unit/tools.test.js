import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeRuntime, FakeBackend, call, tmpDir } from '../helpers.js';
import { validateArgs, formatResult } from '../../src/tools/registry.js';

test('every tool has a valid name, title, description and schema', async () => {
  const rt = await fakeRuntime();
  const tools = rt.host.listTools();
  assert.ok(tools.length >= 25);
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]{1,63}$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, 'object');
    if (!t.annotations.readOnlyHint) assert.ok(t.inputSchema.properties.confirm, `${t.name} accepts confirm`);
  }
});

test('argument validation and coercion', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1 }, b: { type: 'boolean' }, e: { type: 'string', enum: ['a', 'b'] }, arr: { type: 'array', items: { type: 'string' } } }, required: ['e'] };
  assert.deepEqual(validateArgs(schema, { n: '5', b: 'true', e: 'a', arr: '["x"]' }), { n: 5, b: true, e: 'a', arr: ['x'] });
  assert.throws(() => validateArgs(schema, { n: 0, e: 'a' }), />= 1/);
  assert.throws(() => validateArgs(schema, { e: 'z' }), /one of/);
  assert.throws(() => validateArgs(schema, {}), /e is required/);
  assert.throws(() => validateArgs(schema, { e: 'a', arr: [1] }), /must be string/);
});

test('formatResult emits text and image blocks', () => {
  const r = formatResult({ a: 1, __image: Buffer.from('png') });
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].data, Buffer.from('png').toString('base64'));
});

test('policy gates tool calls; confirm token completes the call', async () => {
  const rt = await fakeRuntime();
  const args = { command: 'git push --force origin no-such-branch-xyz' };
  const err = await call(rt, 'terminal_run', args).catch((e) => e);
  assert.equal(err.code, 'CONFIRMATION_REQUIRED');
  await assert.rejects(call(rt, 'terminal_run', { command: 'rm -rf /' }), { code: 'POLICY_DENIED' });
  // token bound to the arguments: different command → rejected
  await assert.rejects(call(rt, 'terminal_run', { command: 'git push --force origin other', confirm: err.details.confirm_token }), /different action/);
  // identical arguments + token → runs (fails harmlessly: the project dir is not a git repo)
  const ran = await call(rt, 'terminal_run', { ...args, confirm: err.details.confirm_token });
  assert.notEqual(ran.exit_code, 0);
});

test('kill switch blocks actions but not observation', async () => {
  const rt = await fakeRuntime();
  rt.policy.setStopped(true);
  await assert.rejects(call(rt, 'input_keyboard', { action: 'type', text: 'x' }), { code: 'KILL_SWITCH' });
  const s = await call(rt, 'safety', { action: 'status' });
  assert.equal(s.kill_switch.engaged, true);
  rt.policy.setStopped(false);
});

test('restricted level requires approval even for low-risk input', async () => {
  const rt = await fakeRuntime({ level: 'restricted' });
  await assert.rejects(call(rt, 'input_keyboard', { action: 'type', text: 'hello' }), { code: 'CONFIRMATION_REQUIRED' });
  const env = await call(rt, 'window', { action: 'list' });
  assert.equal(env.count, 0);
});

test('failsafe corner aborts input', async () => {
  const backend = new FakeBackend();
  const rt = await fakeRuntime({ backend });
  rt.config.safety.failsafeCorner = true;
  backend.mouse = { x: 0, y: 0 };
  await assert.rejects(call(rt, 'input_mouse', { action: 'click', x: 10, y: 10 }), { code: 'KILL_SWITCH' });
});

test('window, mouse and keyboard tools drive the backend', async () => {
  const backend = new FakeBackend({ windows: [{ id: 'a', title: 'Doc - Editor', app: 'editor', pid: 1, x: 0, y: 0, width: 100, height: 100, focused: false }, { id: 'b', title: 'Other', app: 'other', pid: 2, x: 0, y: 0, width: 50, height: 50, focused: true }] });
  const rt = await fakeRuntime({ backend });
  const f = await call(rt, 'window', { action: 'focus', title: 'Doc' });
  assert.equal(f.focused, true);
  await call(rt, 'input_keyboard', { action: 'press', keys: 'mod+s' });
  await call(rt, 'input_keyboard', { action: 'type', text: 'hello' });
  await call(rt, 'input_mouse', { action: 'double_click', x: 5, y: 6 });
  await call(rt, 'input_mouse', { action: 'scroll', direction: 'down', amount: 2 });
  const kinds = backend.events.map((e) => e[0]);
  assert.deepEqual(kinds, ['window', 'key', 'type', 'click', 'scroll']);
  assert.equal(backend.events[3][4], 2, 'double click');
  assert.deepEqual(backend.events[4].slice(1), [0, 2]);
  const closed = await call(rt, 'window', { action: 'close', window_id: 'b' });
  assert.equal(closed.closed, true);
});

test('screenshot coordinates map back to the screen', async () => {
  const backend = new FakeBackend();
  backend.screen = { width: 400, height: 200 };
  const rt = await fakeRuntime({ backend });
  const shot = await call(rt, 'screen_capture', { region: { x: 100, y: 50, width: 200, height: 100 }, max_width: 200 });
  assert.ok(shot.__image);
  assert.deepEqual(shot.region, { x: 100, y: 50, width: 200, height: 100 });
  const full = await call(rt, 'screen_capture', { max_width: 200 });
  assert.equal(full.scale, 0.5);
  await call(rt, 'input_mouse', { action: 'click', x: 50, y: 20, screenshot_id: full.screenshot_id });
  assert.deepEqual(backend.events.at(-1).slice(1, 3), [100, 40]);
});

test('ui_find / ui_action prefer accessibility and fall back to pointer', async () => {
  const backend = new FakeBackend({
    windows: [{ id: 'w', title: 'App', app: 'app', pid: 9, x: 0, y: 0, width: 200, height: 100, focused: true }],
    a11y: [{ role: 'window', name: 'App', x: 0, y: 0, width: 200, height: 100, ref: { id: 'root' }, children: [
      { role: 'push button', name: 'Export', x: 10, y: 10, width: 40, height: 20, ref: { id: 'btn' }, actions: ['press'] },
      { role: 'text', name: 'Name', x: 10, y: 40, width: 40, height: 20, ref: { id: 'txt' } }] }],
  });
  const rt = await fakeRuntime({ backend });
  const found = await call(rt, 'ui_find', { text: 'export' });
  assert.equal(found.matches[0].source, 'a11y');
  assert.deepEqual(found.matches[0].center, { x: 30, y: 20 });
  const act = await call(rt, 'ui_action', { action: 'press', element: found.matches[0].el });
  assert.equal(act.method, 'accessibility');
  backend.a11yAction = async () => { const e = new Error('x'); e.code = 'UNSUPPORTED'; throw Object.assign(e, { code: 'UNSUPPORTED' }); };
  const { ToolError } = await import('../../src/core/errors.js');
  backend.a11yAction = async () => { throw new ToolError('UNSUPPORTED', 'no pattern'); };
  const act2 = await call(rt, 'ui_action', { action: 'press', text: 'Export' });
  assert.equal(act2.method, 'pointer');
  assert.deepEqual(backend.events.at(-1).slice(0, 3), ['click', 30, 20]);
  const tree = await call(rt, 'ui_inspect', { format: 'flat', interactive_only: true });
  assert.ok(tree.elements.some((e) => e.name === 'Export' && e.el.startsWith('el-')));
});

test('destructive UI labels need approval', async () => {
  const backend = new FakeBackend({ windows: [{ id: 'w', title: 'App', app: 'app', pid: 9, x: 0, y: 0, width: 200, height: 100, focused: true }], a11y: [{ role: 'push button', name: "Don't Save", x: 1, y: 1, width: 10, height: 10, ref: { id: 'b' } }] });
  const rt = await fakeRuntime({ backend });
  await assert.rejects(call(rt, 'ui_action', { action: 'press', text: "Don't Save" }), { code: 'CONFIRMATION_REQUIRED' });
});

test('blocked apps are refused', async () => {
  const backend = new FakeBackend({ windows: [{ id: 'w', title: 'Bank', app: 'BankingApp', pid: 9, x: 0, y: 0, width: 200, height: 100, focused: true }] });
  const rt = await fakeRuntime({ backend });
  rt.config.safety.blockedApps = ['bankingapp'];
  await assert.rejects(call(rt, 'input_keyboard', { action: 'type', text: 'x' }), { code: 'POLICY_DENIED' });
  await assert.rejects(call(rt, 'app', { action: 'launch', name: 'BankingApp' }), { code: 'POLICY_DENIED' });
});

test('app launch waits for a window and reports known workflows', async () => {
  const backend = new FakeBackend({ apps: [{ name: 'Gizmo', id: 'gizmo', exec: 'gizmo', source: 'desktop-entry' }] });
  const rt = await fakeRuntime({ backend });
  await call(rt, 'workflow_save', { workflow: { name: 'Do thing', app: 'Gizmo', steps: [{ manual: 'x' }] } });
  const r = await call(rt, 'app', { action: 'launch', name: 'gizmo', timeout_ms: 2000 });
  assert.equal(r.ready, true);
  assert.equal(r.window.title, 'Gizmo');
  assert.equal(r.known_workflows[0].id, 'gizmo/do-thing');
  const again = await call(rt, 'app', { action: 'launch', name: 'gizmo' });
  assert.equal(again.status, 'already-running');
  await assert.rejects(call(rt, 'app', { action: 'launch', name: 'nonexistent-app-xyz' }), { code: 'NOT_FOUND' });
});

test('verify waits and reports evidence', async () => {
  const rt = await fakeRuntime();
  const file = path.join(tmpDir(), 'later.txt');
  setTimeout(() => fs.writeFileSync(file, 'hello world'), 300);
  const r = await call(rt, 'verify', { checks: [{ type: 'file_contains', path: file, text: 'world' }], timeout_ms: 3000, interval_ms: 100 });
  assert.equal(r.ok, true);
  assert.ok(r.attempts > 1);
  const r2 = await call(rt, 'verify', { checks: [{ type: 'window_exists', title: 'nope' }, { type: 'file_exists', path: file }], mode: 'any' });
  assert.equal(r2.ok, true);
  await assert.rejects(call(rt, 'verify', { checks: [{ type: 'bogus' }] }), { code: 'INVALID_ARGUMENT' });
});

test('clipboard round trip and dialog detection', async () => {
  const backend = new FakeBackend({ windows: [{ id: 'm', title: 'Editor', app: 'ed', pid: 3, x: 0, y: 0, width: 800, height: 600 }, { id: 'd', title: 'Save As', app: 'ed', pid: 3, x: 100, y: 100, width: 400, height: 300, focused: true }] });
  const rt = await fakeRuntime({ backend });
  await call(rt, 'clipboard', { action: 'write', text: 'abc' });
  assert.equal((await call(rt, 'clipboard', { action: 'read' })).text, 'abc');
  const d = await call(rt, 'ui_dialog', { action: 'detect' });
  assert.equal(d.dialogs[0].title, 'Save As');
});

test('personal adapters load from the state dir and run through app_script', async () => {
  const { createRuntime } = await import('../../src/index.js');
  const { Logger } = await import('../../src/core/logger.js');
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'adapters'));
  fs.writeFileSync(path.join(home, 'adapters', 'nodey.js'), `export default {
    id: 'nodey', name: 'Nodey',
    locate: { linux: { paths: [${JSON.stringify(process.execPath)}] }, macos: { paths: [${JSON.stringify(process.execPath)}] }, windows: { paths: [${JSON.stringify(process.execPath)}] } },
    scripting: { language: 'js', description: 'evaluates js', async run(ctx, { code }) {
      const r = await ctx.run(ctx.executable, ['-e', code], { timeoutMs: 10000 });
      return { ok: r.code === 0, stdout: r.stdout.trim() };
    } },
  };`);
  const rt = await createRuntime({ env: { ...process.env, COMPUTER_SKILLS_HOME: home, COMPUTER_SKILLS_PROJECT_DIR: tmpDir() }, backend: new FakeBackend(), logger: new Logger({ level: 'silent', stderr: false }), builtinWorkflows: false });
  assert.ok(rt.adapters.get('nodey'));
  const r = await call(rt, 'app_script', { app: 'nodey', code: 'console.log(6*7)' });
  assert.equal(r.stdout, '42');
  assert.equal(r.app, 'Nodey');
});
