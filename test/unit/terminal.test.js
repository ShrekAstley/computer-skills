import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand, analyzeFailure, stripAnsi } from '../../src/terminal/run.js';
import { SessionManager } from '../../src/terminal/sessions.js';
import { ProcessManager, listSystemProcesses, portOpen } from '../../src/terminal/processes.js';
import { availableShells, defaultShell, oneShotInvocation } from '../../src/terminal/shells.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { tmpDir } from '../helpers.js';

const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const isWin = process.platform === 'win32';

test('shells are discovered and a default chosen', () => {
  const shells = availableShells();
  assert.ok(shells.length > 0);
  assert.ok(defaultShell(config));
  const inv = oneShotInvocation({ name: 'pwsh', kind: 'powershell', path: 'pwsh' }, 'Get-Date');
  assert.ok(inv.args.includes('-EncodedCommand'));
});

test('runCommand captures output, exit codes and cwd', async () => {
  const dir = tmpDir();
  const r = await runCommand({ command: 'echo hello', cwd: dir }, { config });
  assert.equal(r.ok, true);
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /hello/);
  assert.equal(r.cwd, dir);
  const f = await runCommand({ command: 'exit 7' }, { config });
  assert.equal(f.exit_code, 7);
  assert.equal(f.ok, false);
  assert.ok(f.failure);
});

test('timeouts kill the command', async () => {
  const r = await runCommand({ command: isWin ? 'ping -n 20 127.0.0.1' : 'sleep 20', timeoutMs: 500 }, { config });
  assert.equal(r.timed_out, true);
  assert.equal(r.failure.category, 'timeout');
  assert.ok(r.duration_ms < 8000);
});

test('stdin and env are passed through', async () => {
  const r = await runCommand({ command: `node -e "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()+process.env.CS_X))"`, stdin: 'abc', env: { CS_X: '!' } }, { config });
  assert.equal(r.stdout.trim(), 'ABC!');
});

test('failure analysis categories', () => {
  assert.equal(analyzeFailure({ code: 127, stderr: 'bash: foo: command not found' }).category, 'not-found');
  assert.equal(analyzeFailure({ code: 1, stderr: 'curl: (6) Could not resolve host: x' }).category, 'network');
  assert.equal(analyzeFailure({ code: 1, stderr: 'Permission denied' }).category, 'permission');
  assert.equal(analyzeFailure({ code: 100, stderr: 'E: Could not get lock /var/lib/dpkg/lock' }).category, 'locked');
  assert.equal(analyzeFailure({ code: 0 }), null);
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('retries retryable failures with backoff', async () => {
  const dir = tmpDir();
  const counter = path.join(dir, 'n');
  const cmd = `node -e "const f=process.argv[1];const fs=require('fs');const n=(fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0)+1;fs.writeFileSync(f,String(n));if(n<2){console.error('ECONNRESET');process.exit(1)}" ${JSON.stringify(counter)}`;
  const r = await runCommand({ command: cmd, retries: 2 }, { config });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
});

test('interactive shell session keeps state and reports exit codes', { skip: isWin && 'POSIX shell session test' }, async () => {
  const sm = new SessionManager({ config });
  const s = sm.start({ cwd: tmpDir() });
  try {
    let r = await s.send({ input: 'export CS_VAR=persisted; cd /' });
    assert.equal(r.exit_code, 0);
    r = await s.send({ input: 'echo "$CS_VAR in $(pwd)"' });
    assert.match(r.output, /persisted in \//);
    assert.doesNotMatch(r.output, /__CS_DONE/);
    r = await s.send({ input: 'false' });
    assert.equal(r.exit_code, 1);
    r = await s.send({ input: 'sleep 5', timeoutMs: 300 });
    assert.equal(r.status, 'timeout');
    s.signal('SIGINT');
    r = await s.send({ input: 'echo after-interrupt' });
    assert.match(r.output, /after-interrupt/);
  } finally {
    sm.disposeAll();
  }
});

test('program sessions (REPL) wait for prompts', async () => {
  const sm = new SessionManager({ config });
  const repl = `node -i`;
  const s = sm.start({ command: repl });
  try {
    await s.read({ waitFor: '> $', timeoutMs: 5000 });
    const r = await s.send({ input: '6*7', waitFor: '42' });
    assert.match(r.output, /42/);
    assert.equal(sm.list().length, 1);
  } finally {
    sm.close(s.id, { force: true });
  }
});

test('background processes: readiness, logs, stop', async () => {
  const pm = new ProcessManager({ config, paths: { logs: tmpDir() } });
  const script = `const http=require('http');const s=http.createServer((q,r)=>r.end('hi')).listen(0,()=>{console.log('listening on '+s.address().port)})`;
  const r = await pm.start({ command: `node -e ${JSON.stringify(script)}`, readyPattern: 'listening on \\d+', readyTimeoutMs: 10000 });
  try {
    assert.equal(r.ready.ready, true);
    const port = Number(r.output_tail.match(/listening on (\d+)/)[1]);
    assert.equal(await portOpen(port), true);
    const logs = await pm.logs(r.id, { grep: 'listening' });
    assert.equal(logs.lines.length, 1);
  } finally {
    const s = await pm.stop(r.id);
    assert.equal(s.running, false);
  }
  const bad = await pm.start({ command: 'exit 3' });
  assert.equal(bad.running, false);
  assert.ok(bad.hint);
  // A command that fails shortly after starting (like slow shell startup on Windows) is still caught.
  const late = await pm.start({ command: `node -e "setTimeout(() => process.exit(4), 800)"` });
  assert.equal(late.running, false);
  assert.equal(late.exit_code, 4);
});

test('system process listing', async () => {
  const r = await listSystemProcesses({ filter: 'node', limit: 5 });
  assert.ok(r.total >= 1);
  assert.ok(fs.existsSync(process.execPath));
});

const psShell = ['pwsh', 'powershell'].find((s) => availableShells().some((x) => x.name === s && x.path && fs.existsSync(x.path)));
test('PowerShell sessions keep state and report accurate exit codes', { skip: !psShell && 'PowerShell not installed' }, async () => {
  const sm = new SessionManager({ config });
  const s = sm.start({ shell: psShell, cwd: tmpDir() });
  try {
    let r = await s.send({ input: '$x = 41', timeoutMs: 30000 });
    assert.equal(r.exit_code, 0);
    r = await s.send({ input: 'Write-Output ($x + 1)', timeoutMs: 30000 });
    assert.match(r.output, /42/);
    r = await s.send({ input: 'node -e "process.exit(3)"', timeoutMs: 30000 });
    assert.equal(r.exit_code, 3);
    r = await s.send({ input: 'Get-Item ./definitely-missing', timeoutMs: 30000 });
    assert.equal(r.exit_code, 1, 'cmdlet failure is not confused with the previous native exit code');
  } finally {
    sm.disposeAll();
  }
});

test('PowerShell one-shot errors are readable text, not CLIXML', { skip: !psShell && 'PowerShell not installed' }, async () => {
  const r = await runCommand({ command: 'Write-Output ok; Get-Item ./definitely-missing', shell: psShell, timeoutMs: 60000 }, { config });
  assert.equal(r.exit_code, 1);
  assert.match(r.stdout, /ok/);
  assert.doesNotMatch(r.stderr, /CLIXML/);
});
