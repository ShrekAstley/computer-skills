import { invalid } from './errors.js';

/**
 * Cross-platform key model. Agents write combos like "mod+s", "ctrl+shift+t",
 * ["alt","f4"] or "Enter"; this module normalises them into
 * { modifiers: ['ctrl'|'alt'|'shift'|'meta'], key: canonicalName } and maps
 * that onto each OS mechanism. `mod` is the platform's primary modifier
 * (Cmd on macOS, Ctrl elsewhere), so "mod+s" means Save everywhere.
 */

const MODIFIER_ALIASES = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', altgr: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta', os: 'meta',
};

const KEY_ALIASES = {
  return: 'enter', enter: 'enter', esc: 'escape', escape: 'escape', tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', bksp: 'backspace', delete: 'delete', del: 'delete', forwarddelete: 'delete', insert: 'insert', ins: 'insert',
  home: 'home', end: 'end', pageup: 'pageup', pgup: 'pageup', page_up: 'pageup', pagedown: 'pagedown', pgdn: 'pagedown', page_down: 'pagedown',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  capslock: 'capslock', printscreen: 'printscreen', prtsc: 'printscreen', menu: 'menu', contextmenu: 'menu', apps: 'menu',
  plus: '+', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
  semicolon: ';', quote: "'", apostrophe: "'", backquote: '`', grave: '`', bracketleft: '[', bracketright: ']',
  numlock: 'numlock', scrolllock: 'scrolllock', pause: 'pause',
};

const NAMED_KEYS = new Set([
  'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'capslock', 'printscreen', 'menu', 'numlock', 'scrolllock', 'pause',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

export function isMac(platform = process.platform) {
  return platform === 'darwin';
}

/**
 * @param {string|string[]} combo
 * @param {string} [platform]
 * @returns {{modifiers: string[], key: string|null}}
 */
export function parseCombo(combo, platform = process.platform) {
  let parts;
  if (Array.isArray(combo)) parts = combo.map(String);
  else if (typeof combo === 'string') {
    const s = combo.trim();
    if (!s) throw invalid('Empty key combination');
    // "+" alone or "ctrl++" → key '+'
    parts = s === '+' ? ['+'] : s.replace(/\+\+$/, '+plus').split('+').map((p) => p.trim()).filter((p) => p !== '');
  } else throw invalid('keys must be a string like "ctrl+s" or an array like ["ctrl","s"]');

  const modifiers = [];
  let key = null;
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    if (lower === 'mod' || lower === 'primary' || lower === 'cmdorctrl' || lower === 'commandorcontrol') {
      const m = isMac(platform) ? 'meta' : 'ctrl';
      if (!modifiers.includes(m)) modifiers.push(m);
      continue;
    }
    if (MODIFIER_ALIASES[lower] && !(parts.length === 1)) {
      const m = MODIFIER_ALIASES[lower];
      if (!modifiers.includes(m)) modifiers.push(m);
      continue;
    }
    if (key !== null) throw invalid(`Key combination "${Array.isArray(combo) ? combo.join('+') : combo}" has more than one non-modifier key`);
    key = normalizeKey(raw);
  }
  // A bare modifier press, e.g. "shift"
  if (key === null && parts.length === 1) key = MODIFIER_ALIASES[parts[0].toLowerCase()] ?? normalizeKey(parts[0]);
  return { modifiers: orderModifiers(modifiers), key };
}

function orderModifiers(mods) {
  const order = ['ctrl', 'alt', 'shift', 'meta'];
  return mods.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function normalizeKey(raw) {
  const s = String(raw);
  const lower = s.toLowerCase().replace(/\s+/g, '');
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower];
  if (NAMED_KEYS.has(lower)) return lower;
  if (MODIFIER_ALIASES[lower]) return MODIFIER_ALIASES[lower];
  if ([...s].length === 1) return s.length === 1 && /[A-Z]/.test(s) ? s.toLowerCase() : s;
  throw invalid(`Unknown key "${raw}"`, {
    hint: 'Use names like enter, escape, tab, space, backspace, delete, up/down/left/right, home, end, pageup, pagedown, f1-f24, or a single character.',
  });
}

export function comboToString({ modifiers, key }) {
  return [...modifiers, key].filter(Boolean).join('+');
}

// ---------------------------------------------------------------- xdotool (X11)
const XDO_KEYS = {
  enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  capslock: 'Caps_Lock', printscreen: 'Print', menu: 'Menu', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock', pause: 'Pause',
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super',
  '+': 'plus', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash', ';': 'semicolon',
  "'": 'apostrophe', '`': 'grave', '[': 'bracketleft', ']': 'bracketright', ' ': 'space', '!': 'exclam', '@': 'at', '#': 'numbersign',
  $: 'dollar', '%': 'percent', '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright',
  _: 'underscore', '{': 'braceleft', '}': 'braceright', '|': 'bar', ':': 'colon', '"': 'quotedbl', '<': 'less', '>': 'greater',
  '?': 'question', '~': 'asciitilde',
};

export function toXdotool(combo) {
  const parts = combo.modifiers.map((m) => XDO_KEYS[m]);
  if (combo.key) {
    let k = XDO_KEYS[combo.key];
    if (!k) k = /^f\d+$/.test(combo.key) ? combo.key.toUpperCase() : combo.key;
    parts.push(k);
  }
  return parts.join('+');
}

// ------------------------------------------------------------- wtype (Wayland)
export function toWtypeArgs(combo) {
  const modMap = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'logo' };
  const args = [];
  for (const m of combo.modifiers) args.push('-M', modMap[m]);
  if (combo.key) {
    const k = XDO_KEYS[combo.key] ?? (/^f\d+$/.test(combo.key) ? combo.key.toUpperCase() : combo.key);
    args.push('-k', k);
  }
  for (const m of combo.modifiers.slice().reverse()) args.push('-m', modMap[m]);
  return args;
}

// --------------------------------------------------------------------- macOS
export const MAC_KEYCODES = {
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, capslock: 57, menu: 110,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

/** Map to System Events: either {keyCode} or {keystroke} plus `using` modifiers. */
export function toMacSystemEvents(combo) {
  const using = combo.modifiers.map((m) => ({ ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down' })[m]);
  const k = combo.key;
  if (k && MAC_KEYCODES[k] !== undefined) return { keyCode: MAC_KEYCODES[k], using };
  if (k && ['ctrl', 'alt', 'shift', 'meta'].includes(k)) return { keyCode: { ctrl: 59, alt: 58, shift: 56, meta: 55 }[k], using };
  return { keystroke: k ?? '', using };
}

// ------------------------------------------------------------------- Windows
const VK = {
  enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28, space: 0x20, capslock: 0x14,
  printscreen: 0x2c, menu: 0x5d, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

/** Map to Windows virtual-key codes. Characters not in the table are resolved by the helper (VkKeyScan). */
export function toWindowsVk(combo) {
  const mods = combo.modifiers.map((m) => VK[m]);
  let key = null;
  let char = null;
  const k = combo.key;
  if (k) {
    if (VK[k] !== undefined) key = VK[k];
    else if (/^f([1-9]|1\d|2[0-4])$/.test(k)) key = 0x6f + Number(k.slice(1));
    else if (/^[a-z]$/.test(k)) key = k.toUpperCase().charCodeAt(0);
    else if (/^[0-9]$/.test(k)) key = k.charCodeAt(0);
    else char = k;
  }
  return { mods, key, char };
}
