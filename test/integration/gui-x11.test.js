// Real desktop automation on Linux/X11. Runs against $DISPLAY, or starts its own
// Xvfb + openbox when available. Skips cleanly when the tools are missing.
//   Requirements: Xvfb (or a display), openbox (any EWMH window manager), xterm,
//   xdotool, wmctrl, x11-utils, imagemagick, xclip, tesseract-ocr.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { which } from '../../src/core/exec.js';
import { createRuntime } from '../../src/index.js';
import { Logger } from '../../src/core/logger.js';
import { tmpDir } from '../helpers.js';
import { sleep } from '../../src/core/util.js';

const needed = ['xdotool', 'wmctrl', 'xterm', 'import', 'tesseract', 'xclip'];
const missing = process.platform !== 'linux' ? ['linux'] : needed.filter((t) => !which(t));
const canStartX = which('Xvfb') && which('openbox');
const skip = missing.length ? `missing: ${missing.join(', ')}` : !process.env.DISPLAY && !canStartX ? 'no DISPLAY and no Xvfb/openbox' : false;

let xvfb, wm, rt, display;
const call = (name, args) => rt.host.invoke(name, args, { via: 'client' });

before(async () => {
  if (skip) return;
  if (process.env.CS_TEST_DISPLAY || !process.env.DISPLAY) {
    display = process.env.CS_TEST_DISPLAY ?? `:${90 + Math.floor(Math.random() * 9)}`;
    if (!process.env.CS_TEST_DISPLAY) {
      xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      await sleep(800);
      wm = spawn('openbox', [], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
      await sleep(800);
    }
  } else display = process.env.DISPLAY;
  const env = { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', COMPUTER_SKILLS_HOME: tmpDir(), COMPUTER_SKILLS_PROJECT_DIR: tmpDir() };
  // The backend reads DISPLAY from process.env.
  process.env.DISPLAY = display;
  delete process.env.WAYLAND_DISPLAY;
  rt = await createRuntime({ env, logger: new Logger({ level: 'silent', stderr: false }), builtinWorkflows: false });
  rt.config.safety.failsafeCorner = true;
});

after(async () => {
  await rt?.dispose();
  wm?.kill();
  xvfb?.kill();
});

test('capabilities are detected', { skip }, async () => {
  const caps = await rt.backend.capabilities();
  assert.equal(caps.screenshot.available, true);
  assert.equal(caps.input.method, 'xdotool');
  assert.ok(caps.windows.available);
});

test('launch → type → OCR → verify → window management → close', { skip }, async () => {
  const title = `CS-IT-${process.pid}`;
  const launched = await call('app', { action: 'launch', path: which('xterm'), args: ['-T', title, '-fa', 'Monospace', '-fs', '12', '-geometry', '80x20+40+40', '-e', 'bash --norc --noprofile'], if_running: 'new', timeout_ms: 15000 });
  assert.equal(launched.ready, true, JSON.stringify(launched));
  const win = launched.window;

  // xterm keeps the -T title because we start bash with --norc (no prompt-driven title changes)
  await call('input_keyboard', { action: 'type', text: 'echo COMPUTER SKILLS WORKS\n', window_id: win.id });
  const v = await call('verify', { checks: [{ type: 'text_visible', text: 'COMPUTER SKILLS WORKS', window_id: win.id }], timeout_ms: 8000 });
  assert.equal(v.ok, true, JSON.stringify(v));

  const found = await call('ui_find', { text: 'SKILLS WORKS', window_id: win.id, method: 'ocr' });
  assert.ok(found.matches.length >= 1);
  const m = found.matches[0];
  assert.ok(m.center.x >= win.x && m.center.x <= win.x + win.width, 'match inside the window (geometry is exact)');

  const shot = await call('screen_capture', { window_id: win.id, include_image: true });
  assert.ok(shot.__image && fs.existsSync(shot.path));

  await call('window', { action: 'move', window_id: win.id, x: 200, y: 150 });
  const moved = (await call('window', { action: 'list' })).windows.find((w) => w.id === win.id);
  assert.ok(Math.abs(moved.x - 200) <= 12 && Math.abs(moved.y - 150) <= 40, JSON.stringify(moved));

  // clipboard round trip through the real X selection
  await call('clipboard', { action: 'write', text: 'clip-123' });
  assert.equal((await call('clipboard', { action: 'read' })).text, 'clip-123');

  // mouse position + failsafe
  await call('input_mouse', { action: 'move', x: 300, y: 300 });
  assert.deepEqual((await call('input_mouse', { action: 'position' })).position, { x: 300, y: 300 });
  await rt.backend.mouseMove(0, 0);
  await assert.rejects(call('input_mouse', { action: 'click', x: 300, y: 300 }), { code: 'KILL_SWITCH' });
  await rt.backend.mouseMove(400, 400);

  // typing into a terminal window is classified as a command
  await assert.rejects(call('input_keyboard', { action: 'type', text: 'sudo reboot\n', window_id: win.id }), { code: 'CONFIRMATION_REQUIRED' });

  const closed = await call('window', { action: 'close', window_id: win.id });
  await call('verify', { checks: [{ type: 'window_absent', window_id: win.id }], timeout_ms: 5000 });
  assert.ok(closed);
});

test('a GUI workflow runs with per-step verification and records success', { skip }, async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'typed.txt');
  const title = `CS-WF-${process.pid}`;
  const r = await call('workflow_save', {
    workflow: {
      name: 'Write file via terminal window',
      app: 'XTerm',
      parameters: [{ name: 'file', required: true }, { name: 'title', required: true }],
      steps: [
        { id: 'open', action: { tool: 'app', args: { action: 'launch', path: which('xterm'), args: ['-T', '{{title}}', '-e', 'bash --norc --noprofile'], if_running: 'new' } }, expect: [{ type: 'window_exists', title: '{{title}}' }], timeout_ms: 15000 },
        { id: 'type', action: { tool: 'input_keyboard', args: { action: 'type', text: 'echo hello > {{file}}\n', title: '{{title}}' } }, expect: [{ type: 'file_contains', path: '{{file}}', text: 'hello' }], timeout_ms: 8000 },
        { id: 'close', action: { tool: 'input_keyboard', args: { action: 'type', text: 'exit\n', title: '{{title}}' } }, expect: [{ type: 'window_absent', title: '{{title}}' }], timeout_ms: 8000 },
      ],
      expected_results: [{ type: 'file_exists', path: '{{file}}' }],
    },
  });
  const run = await call('workflow_run', { id: r.id, params: { file, title } });
  assert.equal(run.status, 'succeeded', JSON.stringify(run, null, 1));
  assert.equal(run.stats.status, 'known');
});
