import { ToolError, ErrorCode } from '../core/errors.js';
import { parseCombo } from '../core/keys.js';
import { sleep } from '../core/util.js';
import { isTerminalWindow } from '../safety/classifier.js';

/**
 * Pointer and keyboard on top of the OS backend, adding the safety failsafe
 * (mouse in the top-left corner aborts), settle delays, and smarter typing.
 */
export class InputService {
  constructor({ backend, config, logger }) {
    this.backend = backend;
    this.config = config;
    this.logger = logger;
    this._failsafeSupported = true;
  }

  async failsafe() {
    if (!this.config.safety?.failsafeCorner || !this._failsafeSupported) return;
    let pos;
    try {
      pos = await this.backend.mousePosition();
    } catch {
      this._failsafeSupported = false; // e.g. Wayland: cannot read the pointer
      return;
    }
    if (pos && pos.x <= 1 && pos.y <= 1) {
      throw new ToolError(ErrorCode.KILL_SWITCH, 'Failsafe triggered: the mouse pointer is in the top-left screen corner', {
        hint: 'The user moved the mouse to the corner to stop automation. Stop and ask the user before continuing.',
        recoverable: false,
      });
    }
  }

  async settle(ms) {
    const d = ms ?? this.config.input?.postActionDelayMs ?? 60;
    if (d > 0) await sleep(d);
  }

  async move({ x, y }) {
    await this.failsafe();
    await this.backend.mouseMove(x, y);
    await this.settle(20);
  }

  async click({ x, y, button = 'left', count = 1, modifiers = [] }) {
    await this.failsafe();
    const mods = modifiers.map((m) => parseCombo(m));
    for (const m of mods) await this.backend.keyToggle(m, 'down');
    try {
      await this.backend.click(x, y, { button, count });
    } finally {
      for (const m of mods.reverse()) await this.backend.keyToggle(m, 'up').catch(() => {});
    }
    await this.settle();
  }

  async mouseButton({ button = 'left', state, x, y }) {
    await this.failsafe();
    if (x !== undefined) await this.backend.mouseMove(x, y);
    await this.backend.mouseButton(button, state);
    await this.settle(20);
  }

  async drag({ from, to, button = 'left', durationMs = 300, steps }) {
    await this.failsafe();
    await this.backend.drag(from, to, { button, steps: steps ?? this.config.input?.dragSteps ?? 12, durationMs });
    await this.settle();
  }

  async scroll({ x, y, dx = 0, dy = 0 }) {
    await this.failsafe();
    await this.backend.scroll({ x, y, dx, dy });
    await this.settle();
  }

  async key(combo, { repeat = 1 } = {}) {
    await this.failsafe();
    await this.backend.key(combo, { repeat });
    await this.settle();
  }

  async keyToggle(combo, state) {
    await this.failsafe();
    await this.backend.keyToggle(combo, state);
  }

  /**
   * Type text. method "keys" sends key events, "paste" goes through the
   * clipboard (fast, exact for long or non-ASCII text; restores the clipboard).
   */
  async type(text, { method = 'auto', delayMs, activeWindow } = {}) {
    await this.failsafe();
    let m = method;
    if (m === 'auto') m = text.length > 400 && !isTerminalWindow(activeWindow) ? 'paste' : 'keys';
    if (m === 'paste') {
      let previous = null;
      try {
        previous = await this.backend.clipboardRead();
      } catch {
        /* clipboard may be unavailable; proceed */
      }
      await this.backend.clipboardWrite(text);
      await sleep(60);
      await this.backend.key(parseCombo(isTerminalWindow(activeWindow) && process.platform === 'linux' ? 'ctrl+shift+v' : 'mod+v'));
      await sleep(150);
      if (previous !== null) await this.backend.clipboardWrite(previous).catch(() => {});
    } else {
      await this.backend.typeText(text, { delayMs: delayMs ?? this.config.input?.typingDelayMs ?? 6 });
    }
    await this.settle();
    return m;
  }
}
