// Spawns the real CLI as an MCP server over stdio and exercises it like a client would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'computer-skills.js');

function startServer(env = {}) {
  const home = tmpDir('cs-int-home-');
  const project = tmpDir('cs-int-proj-');
  const child = spawn(process.execPath, [BIN, 'serve'], {
    env: { ...process.env, COMPUTER_SKILLS_HOME: home, COMPUTER_SKILLS_PROJECT_DIR: project, COMPUTER_SKILLS_LOG_LEVEL: 'warn', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = ++id;
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
      waiters.set(rid, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    });
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const payload = JSON.parse(r.result.content[0].text);
    return { isError: !!r.result.isError, payload, content: r.result.content };
  };
  const stop = () => new Promise((resolve) => {
    child.once('exit', resolve);
    child.stdin.end();
  });
  return { rpc, tool, stop, home, project, child };
}

test('stdio server: lifecycle, tools, workflow memory end to end', async () => {
  const s = startServer();
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'it', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'computer-skills');
    assert.equal(init.result.protocolVersion, '2025-03-26');
    s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const { result } = await s.rpc('tools/list');
    const names = result.tools.map((t) => t.name);
    for (const n of ['terminal_run', 'app', 'screen_capture', 'ui_find', 'input_mouse', 'verify', 'workflow_search', 'workflow_run', 'safety']) assert.ok(names.includes(n), n);

    // Environment model is built and persisted
    const env = await s.tool('env_inspect', { sections: ['system', 'shells', 'safety'] });
    assert.equal(env.isError, false);
    assert.equal(env.payload.safety.level, 'normal');
    assert.ok(fs.existsSync(path.join(s.home, 'context', 'environment.json')));

    // Learn → save → search → run → known
    const out = path.join(s.project, 'artifact.txt');
    const saved = await s.tool('workflow_save', {
      workflow: {
        name: 'Produce artifact',
        app: 'Toolchain',
        triggers: ['produce the artifact'],
        parameters: [{ name: 'out', required: true }],
        steps: [{ id: 'make', title: 'write it', action: { tool: 'terminal_run', args: { command: `node -e "require('fs').writeFileSync(process.argv[1],'built')" "{{out}}"` } }, expect: [{ type: 'file_exists', path: '{{out}}' }] }],
        expected_results: [{ type: 'file_contains', path: '{{out}}', text: 'built' }],
      },
    });
    assert.equal(saved.payload.id, 'toolchain/produce-artifact');
    let found = await s.tool('workflow_search', { query: 'produce artifact' });
    assert.equal(found.payload.results[0].id, 'toolchain/produce-artifact');
    assert.equal(found.payload.status, 'partial');
    const run = await s.tool('workflow_run', { id: 'toolchain/produce-artifact', params: { out } });
    assert.equal(run.payload.status, 'succeeded', JSON.stringify(run.payload));
    assert.equal(fs.readFileSync(out, 'utf8'), 'built');
    found = await s.tool('workflow_search', { query: 'produce artifact' });
    assert.equal(found.payload.status, 'known');

    // Safety: forbidden and confirmation flows over the wire
    const forbidden = await s.tool('terminal_run', { command: 'rm -rf ~' });
    assert.equal(forbidden.isError, true);
    assert.equal(forbidden.payload.error.code, 'POLICY_DENIED');
    const check = await s.tool('safety', { action: 'check', command: 'sudo rm -rf /var/log' });
    assert.equal(check.payload.decision, 'confirm');

    // Background process + session
    const proc = await s.tool('process', { action: 'start', command: `node -e "console.log('ready');setInterval(()=>{},1000)"`, ready_pattern: 'ready' });
    assert.equal(proc.payload.ready.ready, true);
    const stopped = await s.tool('process', { action: 'stop', id: proc.payload.id });
    assert.equal(stopped.payload.running, false);
    const audit = await s.tool('safety', { action: 'audit', limit: 50 });
    assert.ok(audit.payload.entries.some((e) => e.decision === 'deny'));
  } finally {
    await s.stop();
  }
});

test('CLI: doctor, tools, workflows validate', async () => {
  const run = (args) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, COMPUTER_SKILLS_HOME: tmpDir() } });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('exit', (code) => resolve({ code, out }));
    });
  const v = await run(['version']);
  assert.match(v.out, /^\d+\.\d+\.\d+/);
  const tools = await run(['tools']);
  assert.match(tools.out, /workflow_search/);
  const val = await run(['workflows', 'validate', path.resolve(path.dirname(BIN), '..', 'examples', 'workflows')]);
  assert.equal(val.code, 0, val.out);
  const doc = await run(['doctor']);
  assert.match(doc.out, /capabilities:/);
  const call = await run(['call', 'safety', '{"action":"check","command":"ls"}']);
  assert.match(call.out, /"risk": "safe"/);
});
