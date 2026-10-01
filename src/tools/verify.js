import { defineTool } from './registry.js';
import { CHECK, assessment } from './common.js';
import { verifyChecks } from '../verify/checks.js';
import { diagnose } from '../verify/diagnose.js';
import { classifyCommand } from '../safety/classifier.js';
import { SafetyPolicy } from '../safety/policy.js';
import { runCommand } from '../terminal/run.js';

export function checkContext(rt) {
  return {
    backend: rt.backend,
    screen: rt.screen,
    ocr: rt.ocr,
    ui: rt.ui,
    cwd: rt.paths.project.root,
    runCommand: (p) => runCommand({ ...p, cwd: p.cwd || rt.paths.project.root }, { config: rt.config }),
  };
}

export const verifyTool = defineTool({
  name: 'verify',
  title: 'Verify / wait for conditions',
  description:
    'Check observable evidence instead of assuming an action worked — and wait for it. Evaluates `checks` (window_exists, window_absent, window_focused, text_visible, text_absent, ' +
    'element_exists, file_exists, file_absent, file_contains, process_running, process_absent, port_open, http_ok, command_succeeds, screen_changed, clipboard_contains), ' +
    'polling until they pass or `timeout_ms` elapses (0 = check once). Returns per-check evidence. Example: after launching, ' +
    '{"checks":[{"type":"window_exists","app":"blender"}],"timeout_ms":20000}; after saving, {"checks":[{"type":"file_exists","path":"out.png","modified_within_s":60}]}.',
  inputSchema: {
    type: 'object',
    properties: {
      checks: { type: 'array', items: CHECK, description: 'Conditions to verify.' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 600000, description: 'Keep polling up to this long (default 0).' },
      interval_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      mode: { type: 'string', enum: ['all', 'any'], description: 'Pass when all (default) or any checks pass.' },
      screenshot_on_failure: { type: 'boolean', description: 'Attach a screenshot if verification fails (default false).' },
    },
    required: ['checks'],
  },
  assess(a, rt) {
    const cmds = (a.checks || []).filter((c) => c?.type === 'command_succeeds').map((c) => classifyCommand(c.command ?? '', rt.policy.classifierOptions()));
    return cmds.length ? SafetyPolicy.combine(...cmds) : assessment('safe');
  },
  summary: (a) => `verify ${(a.checks || []).map((c) => c.type).join(', ')}`,
  async handler(a, rt, call) {
    const r = await verifyChecks(a.checks, checkContext(rt), { timeoutMs: a.timeout_ms ?? 0, intervalMs: a.interval_ms ?? 500, mode: a.mode ?? 'all', signal: call.signal });
    if (!r.ok && a.screenshot_on_failure) {
      try {
        const { meta, png } = await rt.screen.capture({});
        r.screenshot_id = meta.id;
        r.__image = png;
      } catch {
        /* ignore */
      }
    }
    if (!r.ok) r.hint = 'Verification failed. Look at the evidence (and a screenshot), then recover: diagnose can summarise app state and open dialogs.';
    return r;
  },
});

export const diagnoseTool = defineTool({
  name: 'diagnose',
  title: 'Diagnose the current state',
  description:
    'When something did not go as expected: summarises what is going on — focused window, whether the app is still running (crash), open dialogs and their text/buttons, ' +
    'focus problems, recent app log output — with concrete recovery suggestions. Optionally attaches a screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'The application you were working with.' },
      include_screenshot: { type: 'boolean', description: 'Attach a screenshot (default true).' },
      read_dialogs: { type: 'boolean', description: 'OCR open dialogs (default true).' },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    const res = await diagnose(rt, { app: a.app, includeScreenshot: a.include_screenshot ?? true, readDialogs: a.read_dialogs ?? true });
    if (res.__image) {
      const img = res.__image;
      delete res.__image;
      return { ...res, __image: img };
    }
    return res;
  },
});
