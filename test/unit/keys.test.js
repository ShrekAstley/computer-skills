import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombo, comboToString, toXdotool, toMacSystemEvents, toWindowsVk, toWtypeArgs } from '../../src/core/keys.js';

test('parses combos from strings and arrays', () => {
  assert.deepEqual(parseCombo('ctrl+shift+s', 'linux'), { modifiers: ['ctrl', 'shift'], key: 's' });
  assert.deepEqual(parseCombo(['Shift', 'Ctrl', 'T'], 'linux'), { modifiers: ['ctrl', 'shift'], key: 't' });
  assert.deepEqual(parseCombo('Enter', 'linux'), { modifiers: [], key: 'enter' });
  assert.deepEqual(parseCombo('esc'), { modifiers: [], key: 'escape' });
  assert.deepEqual(parseCombo('shift'), { modifiers: [], key: 'shift' });
  assert.deepEqual(parseCombo('ctrl++'), { modifiers: ['ctrl'], key: '+' });
  assert.deepEqual(parseCombo('alt+F4'), { modifiers: ['alt'], key: 'f4' });
});

test('mod maps to the platform primary modifier', () => {
  assert.deepEqual(parseCombo('mod+s', 'darwin').modifiers, ['meta']);
  assert.deepEqual(parseCombo('mod+s', 'linux').modifiers, ['ctrl']);
  assert.deepEqual(parseCombo('cmd+q', 'win32').modifiers, ['meta']);
  assert.deepEqual(parseCombo('option+left', 'darwin'), { modifiers: ['alt'], key: 'left' });
});

test('rejects invalid combos', () => {
  assert.throws(() => parseCombo('ctrl+a+b'), /more than one/);
  assert.throws(() => parseCombo('ctrl+nonsensekey'), /Unknown key/);
  assert.throws(() => parseCombo(''), /Empty/);
});

test('maps to xdotool keysyms', () => {
  assert.equal(toXdotool(parseCombo('ctrl+shift+t', 'linux')), 'ctrl+shift+t');
  assert.equal(toXdotool(parseCombo('enter')), 'Return');
  assert.equal(toXdotool(parseCombo('meta+pagedown', 'linux')), 'super+Page_Down');
  assert.equal(toXdotool(parseCombo('f12')), 'F12');
  assert.equal(toXdotool(parseCombo('ctrl+/')), 'ctrl+slash');
});

test('maps to macOS System Events', () => {
  assert.deepEqual(toMacSystemEvents(parseCombo('mod+s', 'darwin')), { keystroke: 's', using: ['command down'] });
  assert.deepEqual(toMacSystemEvents(parseCombo('enter', 'darwin')), { keyCode: 36, using: [] });
  assert.deepEqual(toMacSystemEvents(parseCombo('cmd+shift+g', 'darwin')), { keystroke: 'g', using: ['shift down', 'command down'] });
});

test('maps to Windows virtual keys', () => {
  assert.deepEqual(toWindowsVk(parseCombo('ctrl+s', 'win32')), { mods: [0x11], key: 0x53, char: null });
  assert.deepEqual(toWindowsVk(parseCombo('alt+f4', 'win32')), { mods: [0x12], key: 0x73, char: null });
  assert.deepEqual(toWindowsVk(parseCombo('?', 'win32')), { mods: [], key: null, char: '?' });
  assert.equal(toWindowsVk(parseCombo('f24')).key, 0x87);
});

test('wtype args press and release modifiers', () => {
  assert.deepEqual(toWtypeArgs(parseCombo('ctrl+s', 'linux')), ['-M', 'ctrl', '-k', 's', '-m', 'ctrl']);
});

test('comboToString', () => {
  assert.equal(comboToString(parseCombo(['shift', 'ctrl', 'p'], 'linux')), 'ctrl+shift+p');
});
