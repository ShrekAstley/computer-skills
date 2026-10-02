import path from 'node:path';
import fsp from 'node:fs/promises';
import { defineAdapter } from '../adapter.js';
import { run } from '../../core/exec.js';
import { ToolError, ErrorCode } from '../../core/errors.js';
import { truncateMiddle } from '../../core/util.js';

const chromiumKnowledge = {
  shortcuts: {
    'focus address bar': 'mod+l',
    'new tab': 'mod+t',
    'close tab': 'mod+w',
    'reopen closed tab': 'mod+shift+t',
    'next tab': 'ctrl+tab',
    'reload': 'mod+r',
    'hard reload': 'mod+shift+r',
    'find in page': 'mod+f',
    'developer tools': 'f12',
    'zoom in / out / reset': 'mod+= / mod+- / mod+0',
    'save page': 'mod+s',
    'print / save as PDF': 'mod+p',
  },
  tips: [
    'To open a URL: launch with the URL as an argument, or focus the address bar (mod+l), type the URL and press Enter.',
    'For headless, reliable page work use app_script: operation "dump_dom" (rendered HTML), "screenshot" (PNG of a URL) or "pdf" — no GUI needed.',
    'Browser chrome is accessible (tabs, address bar); web page content usually is too, but complex pages are easier to read with OCR or dump_dom.',
    'For deep automation (click by CSS selector, forms) launch with --remote-debugging-port=9222 and use a CDP/Playwright based tool if available.',
  ],
  verification: ['After navigation: the window title usually contains the page title; screen_text can confirm visible content.'],
};

function chromiumScripting(name) {
  return {
    language: 'cli',
    description: `Headless ${name} operations: {"operation": "dump_dom"|"screenshot"|"pdf", "url": "...", "output": "path (screenshot/pdf)", "window_size": "1280,800"}.`,
    async run(ctx, { operation = 'dump_dom', url, output, windowSize = '1280,800', timeoutMs = 60000 }) {
      if (!url) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'url is required');
      const exe = ctx.executable;
      if (!exe) throw new ToolError(ErrorCode.NOT_FOUND, `${name} executable not found`);
      const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--window-size=${windowSize}`];
      if (operation === 'dump_dom') args.push('--dump-dom', url);
      else if (operation === 'screenshot') {
        if (!output) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'output path is required for screenshot');
        await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        args.push(`--screenshot=${path.resolve(output)}`, url);
      } else if (operation === 'pdf') {
        if (!output) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'output path is required for pdf');
        args.push(`--print-to-pdf=${path.resolve(output)}`, url);
      } else throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown operation ${operation}`);
      const r = await run(exe, args, { timeoutMs, signal: ctx.signal });
      const res = { ok: r.code === 0, exit_code: r.code, operation };
      if (operation === 'dump_dom') res.html = truncateMiddle(r.stdout, 60000).text;
      else res.output = path.resolve(output);
      if (r.code !== 0) res.stderr = truncateMiddle(r.stderr, 4000).text;
      return res;
    },
  };
}

export const chrome = defineAdapter({
  id: 'chrome',
  name: 'Google Chrome',
  aliases: ['chrome', 'google chrome', 'browser', 'web browser'],
  categories: ['browser'],
  locate: {
    linux: { executables: ['google-chrome', 'google-chrome-stable'], desktopIds: ['google-chrome'] },
    macos: { bundleNames: ['Google Chrome.app'], paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    windows: { executables: ['chrome.exe'], paths: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] },
  },
  window: { titlePattern: 'Google Chrome' },
  version: { args: ['--version'], pattern: '(\\d+\\.\\d+\\.\\d+\\.\\d+)' },
  launchArgs: ({ params }) => [...(params.newWindow ? ['--new-window'] : []), ...(params.url ? [params.url] : [])],
  scripting: chromiumScripting('Chrome'),
  knowledge: chromiumKnowledge,
});

export const chromium = defineAdapter({
  id: 'chromium',
  name: 'Chromium',
  aliases: ['chromium-browser'],
  categories: ['browser'],
  locate: {
    linux: { executables: ['chromium', 'chromium-browser'], desktopIds: ['chromium', 'chromium-browser', 'org.chromium.Chromium'] },
    macos: { bundleNames: ['Chromium.app'], paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
    windows: { executables: ['chromium.exe'] },
  },
  window: { titlePattern: 'Chromium' },
  version: { args: ['--version'], pattern: '(\\d+\\.\\d+\\.\\d+\\.\\d+)' },
  launchArgs: ({ params }) => [...(params.newWindow ? ['--new-window'] : []), ...(params.url ? [params.url] : [])],
  scripting: chromiumScripting('Chromium'),
  knowledge: chromiumKnowledge,
});

export const edge = defineAdapter({
  id: 'edge',
  name: 'Microsoft Edge',
  aliases: ['msedge', 'edge'],
  categories: ['browser'],
  locate: {
    linux: { executables: ['microsoft-edge', 'microsoft-edge-stable'], desktopIds: ['microsoft-edge'] },
    macos: { bundleNames: ['Microsoft Edge.app'], paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
    windows: { executables: ['msedge.exe'], paths: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'] },
  },
  window: { titlePattern: 'Microsoft.? Edge' },
  launchArgs: ({ params }) => (params.url ? [params.url] : []),
  scripting: chromiumScripting('Edge'),
  knowledge: chromiumKnowledge,
});

export const firefox = defineAdapter({
  id: 'firefox',
  name: 'Firefox',
  aliases: ['mozilla firefox'],
  categories: ['browser'],
  locate: {
    linux: { executables: ['firefox', 'firefox-esr'], desktopIds: ['firefox', 'firefox-esr', 'org.mozilla.firefox'] },
    macos: { bundleNames: ['Firefox.app'], paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    windows: { executables: ['firefox.exe'], paths: ['C:/Program Files/Mozilla Firefox/firefox.exe'] },
  },
  window: { titlePattern: 'Mozilla Firefox|Firefox' },
  version: { args: ['--version'], pattern: 'Firefox\\s+([\\d.]+)' },
  launchArgs: ({ params }) => [...(params.newWindow ? ['--new-window'] : []), ...(params.url ? [params.url] : [])],
  scripting: {
    language: 'cli',
    description: 'Headless Firefox: {"operation": "screenshot", "url": "...", "output": "path"}.',
    async run(ctx, { operation = 'screenshot', url, output, windowSize = '1280,800', timeoutMs = 60000 }) {
      if (operation !== 'screenshot') throw new ToolError(ErrorCode.UNSUPPORTED, 'Firefox scripting supports only "screenshot"; use Chrome/Chromium for dump_dom/pdf.');
      if (!url || !output) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'url and output are required');
      const r = await run(ctx.executable, ['--headless', `--window-size=${windowSize}`, '--screenshot', path.resolve(output), url], { timeoutMs, signal: ctx.signal });
      return { ok: r.code === 0, exit_code: r.code, output: path.resolve(output) };
    },
  },
  knowledge: { ...chromiumKnowledge, tips: chromiumKnowledge.tips.filter((t) => !t.includes('dump_dom')) },
});
