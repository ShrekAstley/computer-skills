// Smoke tests for the macOS and Windows native helpers. They run only on those
// OSes (e.g. the CI matrix) and stick to calls that need no special permissions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../../src/platform/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { parseCombo } from '../../src/core/keys.js';
import { tmpDir } from '../helpers.js';

const paths = { tmp: tmpDir(), logs: tmpDir(), screenshots: tmpDir() };
const backend = createBackend({ config: DEFAULT_CONFIG, logger: null, paths });
after(() => backend.dispose?.());

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

test('windows helper: starts, reports capabilities, lists screens and windows', { skip: !win && 'Windows only' }, async () => {
  const caps = await backend.capabilities();
  assert.equal(caps.input.available, true, JSON.stringify(caps));
  const screens = await backend.screens();
  assert.ok(screens.length >= 1);
  assert.ok(screens[0].width > 0);
  const wins = await backend.listWindows();
  assert.ok(Array.isArray(wins));
  for (const w of wins) assert.match(w.id, /^0x[0-9a-f]+$/);
  const pos = await backend.mousePosition();
  assert.equal(typeof pos.x, 'number');
  if (!process.env.CI) {
    // Hosted CI runners may not have an interactive clipboard owner.
    await backend.clipboardWrite('cs-clip-✓');
    assert.equal(await backend.clipboardRead(), 'cs-clip-✓');
  }
  const apps = await backend.listApps();
  assert.ok(Array.isArray(apps));
  // key mapping reaches SendInput without throwing (shift alone is harmless)
  await backend.key(parseCombo('shift'));
});

test('windows helper: survives a bad request and keeps serving', { skip: !win && 'Windows only' }, async () => {
  await assert.rejects(backend.windowAction('0x0', 'focus'), /window no longer exists|NOT_FOUND|focus/i);
  const screens = await backend.screens();
  assert.ok(screens.length >= 1);
});

test('macOS helper: screens, mouse position, running apps, window list', { skip: !mac && 'macOS only' }, async () => {
  const screens = await backend.screens();
  assert.ok(screens.length >= 1 && screens[0].width > 0, JSON.stringify(screens));
  const pos = await backend.mousePosition();
  assert.equal(typeof pos.x, 'number');
  const apps = await backend.runningApps('');
  assert.ok(Array.isArray(apps));
  const wins = await backend.listWindows();
  assert.ok(Array.isArray(wins));
  const installed = await backend.listApps();
  assert.ok(installed.some((a) => /Safari|Finder|Calculator|TextEdit/i.test(a.name)));
  await backend.clipboardWrite('cs-clip');
  assert.equal(await backend.clipboardRead(), 'cs-clip');
});
