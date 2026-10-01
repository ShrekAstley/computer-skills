import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McpServer } from '../../src/mcp/server.js';
import { fakeRuntime } from '../helpers.js';

function harness(toolHost, { capabilities = {} } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer({ toolHost, input, output, instructions: 'hi' });
  server.start();
  const pending = new Map();
  const serverRequests = [];
  let buf = '';
  output.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.method) serverRequests.push(msg);
      else pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const rid = ++id;
      pending.set(rid, resolve);
      input.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    });
  const respond = (rid, result) => input.write(JSON.stringify({ jsonrpc: '2.0', id: rid, result }) + '\n');
  const init = () => send('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } });
  return { send, respond, init, serverRequests, server, input };
}

test('initialize negotiates protocol version and returns instructions', async () => {
  const rt = await fakeRuntime();
  const h = harness(rt.host);
  const r = await h.init();
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.instructions, 'hi');
  const old = await h.send('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(old.result.protocolVersion, '2025-06-18');
  assert.deepEqual((await h.send('ping')).result, {});
  assert.equal((await h.send('nope/nope')).error.code, -32601);
});

test('tools/list and tools/call, including errors', async () => {
  const rt = await fakeRuntime();
  const h = harness(rt.host);
  await h.init();
  const list = await h.send('tools/list');
  assert.ok(list.result.tools.find((t) => t.name === 'terminal_run'));
  const ok = await h.send('tools/call', { name: 'terminal_run', arguments: { command: 'echo mcp-ok' } });
  assert.match(JSON.parse(ok.result.content[0].text).stdout, /mcp-ok/);
  const bad = await h.send('tools/call', { name: 'terminal_run', arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.result.content[0].text).error.code, 'INVALID_ARGUMENT');
  const unknown = await h.send('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
});

test('high-risk calls are approved through elicitation when the client supports it', async () => {
  const rt = await fakeRuntime();
  const h = harness(rt.host, { capabilities: { elicitation: {} } });
  await h.init();
  const pending = h.send('tools/call', { name: 'terminal_run', arguments: { command: 'git push --force origin nothing-here-xyz', cwd: process.cwd() } });
  // wait for the server's elicitation request and approve once
  for (let i = 0; i < 100 && !h.serverRequests.length; i++) await new Promise((r) => setTimeout(r, 10));
  const req = h.serverRequests[0];
  assert.equal(req.method, 'elicitation/create');
  assert.match(req.params.message, /HIGH-risk/);
  h.respond(req.id, { action: 'decline' });
  const res = await pending;
  assert.equal(res.result.isError, true);
  assert.match(JSON.parse(res.result.content[0].text).error.message, /declined/);
});

test('cancellation aborts a running tool', async () => {
  const rt = await fakeRuntime();
  const h = harness(rt.host);
  await h.init();
  const started = Date.now();
  const p = h.send('tools/call', { name: 'terminal_run', arguments: { command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30' } });
  await new Promise((r) => setTimeout(r, 300));
  h.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 + 0 } }) + '\n');
  // request ids: initialize=1, tools/call=2
  h.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n');
  const res = await p;
  assert.ok(Date.now() - started < 10000);
  assert.equal(JSON.parse(res.result.content[0].text).cancelled, true);
});
