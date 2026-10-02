import { ToolError, ErrorCode } from '../core/errors.js';

/**
 * Contract every OS backend implements. Methods a backend cannot support
 * should throw UNSUPPORTED/DEPENDENCY_MISSING with an actionable hint rather
 * than silently doing nothing — the agent needs to know to fall back.
 *
 * Coordinates are always *logical screen coordinates* (the space mouse events
 * use). Captures report `pixelRatio` (image pixels per logical pixel) so the
 * screen layer can map between image and screen space (HiDPI/Retina).
 *
 * @typedef {{id: string, title: string, app: string, pid?: number, className?: string,
 *            x: number, y: number, width: number, height: number, focused?: boolean,
 *            minimized?: boolean, workspace?: string|number}} WindowInfo
 * @typedef {{name: string, id: string, path?: string, exec?: string, source: string,
 *            version?: string, bundleId?: string, wmClass?: string, categories?: string[]}} AppEntry
 * @typedef {{id: string, role: string, name: string, value?: string, description?: string,
 *            x?: number, y?: number, width?: number, height?: number, enabled?: boolean,
 *            focused?: boolean, actions?: string[], children?: object[], ref?: object}} A11yNode
 */
export class Backend {
  constructor({ config, logger, paths }) {
    this.config = config;
    this.logger = logger;
    this.paths = paths;
  }

  /** Short identifier of the mechanism, e.g. "linux-x11", "macos", "windows". */
  get name() {
    return 'unknown';
  }

  info() {
    return { os: process.platform };
  }

  async capabilities() {
    return {};
  }

  unsupported(what, hint) {
    return new ToolError(ErrorCode.UNSUPPORTED, `${what} is not supported by the ${this.name} backend`, { hint });
  }

  async screens() { throw this.unsupported('Listing screens'); }
  async capture() { throw this.unsupported('Screen capture'); }
  async listWindows() { throw this.unsupported('Window listing'); }
  async activeWindow() {
    const wins = await this.listWindows();
    return wins.find((w) => w.focused) ?? null;
  }
  async windowAction() { throw this.unsupported('Window management'); }
  async mouseMove() { throw this.unsupported('Mouse control'); }
  async mouseButton() { throw this.unsupported('Mouse buttons'); }
  async click() { throw this.unsupported('Mouse clicks'); }
  async scroll() { throw this.unsupported('Scrolling'); }
  async mousePosition() { throw this.unsupported('Reading the mouse position'); }
  async key() { throw this.unsupported('Keyboard input'); }
  async keyToggle() { throw this.unsupported('Holding keys'); }
  async typeText() { throw this.unsupported('Typing text'); }
  async clipboardRead() { throw this.unsupported('Clipboard access'); }
  async clipboardWrite() { throw this.unsupported('Clipboard access'); }
  async listApps() { return []; }
  async launch() { throw this.unsupported('Launching applications'); }
  async a11yTree() { throw this.unsupported('Accessibility inspection'); }
  async a11yAction() { throw this.unsupported('Accessibility actions'); }
  async menuSelect() { throw this.unsupported('Native menu selection'); }
  async ocrNative() { return null; }
  async openPath() { throw this.unsupported('Opening files'); }

  /** Generic drag implemented on primitives; backends may override with a native one. */
  async drag(from, to, { button = 'left', steps = 12, durationMs = 300, holdMs = 80 } = {}) {
    await this.mouseMove(from.x, from.y);
    await this.mouseButton(button, 'down');
    await new Promise((r) => setTimeout(r, holdMs));
    const n = Math.max(1, steps);
    for (let i = 1; i <= n; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / n);
      const y = Math.round(from.y + ((to.y - from.y) * i) / n);
      await this.mouseMove(x, y);
      await new Promise((r) => setTimeout(r, durationMs / n));
    }
    await new Promise((r) => setTimeout(r, holdMs));
    await this.mouseButton(button, 'up');
  }

  async dispose() {}
}
