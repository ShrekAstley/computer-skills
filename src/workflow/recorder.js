import { ToolError, ErrorCode } from '../core/errors.js';
import { nowIso } from '../core/util.js';

// Tools whose calls are observations, not actions: never recorded as steps.
const NON_RECORDED = new Set([
  'env_inspect', 'screen_capture', 'screen_text', 'ui_inspect', 'ui_find', 'diagnose', 'safety', 'app_profile', 'clipboard',
  'workflow_search', 'workflow_get', 'workflow_save', 'workflow_run', 'workflow_feedback', 'workflow_record', 'workflow_versions',
]);
const READ_ACTIONS = new Set(['list', 'active', 'status', 'find', 'read', 'logs', 'position', 'detect', 'system']);

/**
 * Records what the agent does while learning a task, turning successful
 * actions into a draft workflow. Failed calls are dropped; `verify` calls
 * become the expectations of the preceding step; ephemeral handles (element
 * ids, screenshot ids) are rewritten into durable text targets.
 */
export class WorkflowRecorder {
  constructor({ elements }) {
    this.elements = elements;
    this.active = null;
  }

  status() {
    if (!this.active) return { recording: false };
    return { recording: true, name: this.active.name, app: this.active.app, started: this.active.started, steps: this.active.steps.length, notes: this.active.notes.length };
  }

  start({ name, app, description }) {
    if (this.active) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Already recording "${this.active.name}"`, { hint: 'Stop or discard the current recording first.' });
    if (!name || !app) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'name and app are required');
    this.active = { name, app, description, started: nowIso(), steps: [], notes: [], warnings: [] };
    return this.status();
  }

  annotate(note) {
    if (!this.active) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Not recording');
    this.active.notes.push(note);
    const last = this.active.steps[this.active.steps.length - 1];
    if (last) last.hints = { ...(last.hints || {}), notes: [last.hints?.notes, note].filter(Boolean).join(' ') };
    return this.status();
  }

  /** Called by the tool host after every successful tool call. */
  observe(tool, args, result) {
    if (!this.active) return;
    if (tool === 'verify') {
      const last = this.active.steps[this.active.steps.length - 1];
      if (last && result?.ok) last.expect = [...(last.expect || []), ...(args.checks || [])];
      return;
    }
    if (NON_RECORDED.has(tool)) return;
    if (READ_ACTIONS.has(args?.action)) return;
    const { confirm, ...clean } = args || {};
    const durable = this._durable(tool, clean);
    this.active.steps.push({
      id: `step-${this.active.steps.length + 1}`,
      title: describe(tool, durable),
      action: { tool, args: durable },
    });
  }

  _durable(tool, args) {
    const out = { ...args };
    for (const key of ['element', 'to_element']) {
      if (!out[key]) continue;
      let rec = null;
      try {
        rec = this.elements.get(out[key]);
      } catch {
        rec = null;
      }
      if (rec?.name) {
        const textKey = key === 'element' ? 'text' : 'to_text';
        out[textKey] = rec.name;
        if (key === 'element' && rec.role && rec.role !== 'text') out.role = rec.role;
        delete out[key];
      } else {
        this.active.warnings.push(`${tool}: element ${out[key]} had no label; the step needs a text target or coordinates.`);
      }
    }
    if (out.screenshot_id) {
      delete out.screenshot_id;
      this.active.warnings.push(`${tool}: used screenshot-relative coordinates; they were converted to absolute coordinates which are brittle. Prefer text targets.`);
    }
    if (tool === 'input_mouse' && out.x !== undefined && !out.text) {
      this.active.warnings.push(`${tool} at (${out.x},${out.y}) uses raw coordinates — replace with a text/element target if possible.`);
    }
    return out;
  }

  stop() {
    if (!this.active) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Not recording');
    const a = this.active;
    this.active = null;
    const draft = {
      name: a.name,
      app: a.app,
      description: a.description ?? '',
      platforms: [{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? process.platform],
      parameters: [],
      steps: a.steps,
      expected_results: [],
      notes: a.notes,
    };
    return {
      draft,
      warnings: a.warnings,
      next: [
        'Review the draft: remove exploratory or redundant steps, give steps clear titles, and add "expect" checks to important steps.',
        'Replace literal values that vary between runs (file paths, names) with {{parameters}} and declare them in "parameters".',
        'Add "expected_results" (e.g. file_exists for outputs) and known "failure_modes".',
        'Save with workflow_save (verified=true if the task just succeeded).',
      ],
    };
  }

  discard() {
    const had = !!this.active;
    this.active = null;
    return { discarded: had };
  }
}

function describe(tool, args) {
  switch (tool) {
    case 'app': return `${args.action ?? 'use'} ${args.name ?? args.path ?? 'app'}`;
    case 'input_keyboard': return args.action === 'type' ? `Type "${String(args.text ?? '').slice(0, 40)}"` : `Press ${Array.isArray(args.keys) ? args.keys.join('+') : args.keys}`;
    case 'input_mouse': return `${args.action ?? 'click'} ${args.text ? `"${args.text}"` : args.x !== undefined ? `at ${args.x},${args.y}` : ''}`.trim();
    case 'ui_action': return `${args.action ?? 'press'} "${args.text ?? args.element}"`;
    case 'ui_menu': return `Menu ${(args.path || []).join(' > ')}`;
    case 'ui_dialog': return `Dialog: ${args.action}${args.button ? ` "${args.button}"` : ''}${args.path ? ` ${args.path}` : ''}`;
    case 'window': return `Window ${args.action}`;
    case 'terminal_run': return `Run: ${String(args.command).slice(0, 60)}`;
    case 'app_script': return `Script in ${args.app}`;
    default: return tool;
  }
}
