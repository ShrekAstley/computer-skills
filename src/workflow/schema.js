import { ToolError, ErrorCode } from '../core/errors.js';
import { slugify } from '../core/paths.js';
import { validateCheck } from '../verify/checks.js';

export const WORKFLOW_SCHEMA_VERSION = 1;

/**
 * Workflow document (JSON):
 * {
 *   "schema": 1,
 *   "id": "blender/export-png",                // <app>/<task>
 *   "name": "Export render as PNG",
 *   "app": {"id": "blender", "name": "Blender", "version": ">=4.0", "tested_version": "4.2.1"},
 *   "platforms": ["linux", "windows", "macos"],
 *   "description": "...", "tags": [...], "triggers": ["export png", ...],
 *   "parameters": [{"name": "output_path", "type": "path", "required": true, "description": "...", "default": ...}],
 *   "preconditions": [<check>...],             // must hold before step 1
 *   "steps": [{
 *       "id": "render", "title": "Render the image",
 *       "action": {"tool": "input_keyboard", "args": {"action": "press", "keys": "f12"}},   // or "manual": "instruction for the agent"
 *       "expect": [<check>...], "timeout_ms": 30000, "retries": 1,
 *       "on_failure": "retry" | "abort" | "continue" | "recover",
 *       "recovery": [<step>...],                 // run when the step fails, before retrying
 *       "hints": {"location": "Render menu > Render Image", "shortcut": "F12", "notes": "..."}
 *   }],
 *   "expected_results": [<check>...],          // verified after the last step
 *   "failure_modes": [{"symptom": "...", "detect": <check>, "recovery": "..."}],
 *   "notes": ["..."],
 *   "stats": {"runs": 0, "successes": 0, "failures": 0, "last_success": null, "last_failure": null, "last_verified": null, "last_failure_reason": null},
 *   "version": 1, "history": [{"version": 1, "date": "...", "change": "..."}],
 *   "source": "learned" | "builtin" | "user", "created": "...", "updated": "..."
 * }
 */

const STEP_FAILURE = ['retry', 'abort', 'continue', 'recover'];

export function validateWorkflow(wf, { partial = false } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!wf || typeof wf !== 'object') throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Workflow must be an object');
  if (!partial || wf.name !== undefined) if (!wf.name || typeof wf.name !== 'string') err('name is required');
  if (!partial || wf.app !== undefined) {
    if (!wf.app || (typeof wf.app !== 'object' && typeof wf.app !== 'string')) err('app is required (string or {name, id, version})');
  }
  if (!partial || wf.steps !== undefined) {
    if (!Array.isArray(wf.steps) || !wf.steps.length) err('steps must be a non-empty array');
    else {
      const ids = new Set();
      wf.steps.forEach((s, i) => {
        const where = `steps[${i}]`;
        if (!s || typeof s !== 'object') return err(`${where} must be an object`);
        if (s.id) {
          if (ids.has(s.id)) err(`${where}.id "${s.id}" is duplicated`);
          ids.add(s.id);
        }
        const hasAction = s.action && typeof s.action === 'object' && typeof s.action.tool === 'string';
        if (!hasAction && typeof s.manual !== 'string') err(`${where} needs "action": {"tool", "args"} or "manual": "<instruction>"`);
        if (s.action && s.action.args !== undefined && typeof s.action.args !== 'object') err(`${where}.action.args must be an object`);
        if (s.on_failure && !STEP_FAILURE.includes(s.on_failure)) err(`${where}.on_failure must be one of ${STEP_FAILURE.join(', ')}`);
        for (const [j, c] of (s.expect || []).entries()) {
          try {
            validateCheck(c);
          } catch (e) {
            err(`${where}.expect[${j}]: ${e.message}`);
          }
        }
        if (s.recovery && !Array.isArray(s.recovery)) err(`${where}.recovery must be an array of steps`);
      });
    }
  }
  for (const key of ['preconditions', 'expected_results']) {
    if (wf[key] === undefined) continue;
    if (!Array.isArray(wf[key])) {
      err(`${key} must be an array of checks`);
      continue;
    }
    wf[key].forEach((c, j) => {
      try {
        validateCheck(c);
      } catch (e) {
        err(`${key}[${j}]: ${e.message}`);
      }
    });
  }
  if (wf.parameters !== undefined) {
    if (!Array.isArray(wf.parameters)) err('parameters must be an array');
    else wf.parameters.forEach((p, i) => (!p || !p.name) && err(`parameters[${i}].name is required`));
  }
  if (errors.length) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Invalid workflow: ${errors.join('; ')}`, { details: { errors } });
  return wf;
}

export function normalizeApp(app) {
  if (!app) return { id: 'generic', name: 'Generic' };
  if (typeof app === 'string') return { id: slugify(app), name: app };
  return { ...app, id: app.id ? slugify(app.id) : slugify(app.name || 'generic'), name: app.name || app.id };
}

export function workflowId(app, name) {
  return `${normalizeApp(app).id}/${slugify(name)}`;
}

/** Fill defaults so stored documents are uniform. */
export function normalizeWorkflow(wf) {
  const app = normalizeApp(wf.app);
  const id = wf.id && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(wf.id) ? wf.id : workflowId(app, wf.name);
  const steps = wf.steps.map((s, i) => ({ id: s.id || `step-${i + 1}`, ...s }));
  return {
    schema: WORKFLOW_SCHEMA_VERSION,
    id,
    name: wf.name,
    app,
    platforms: wf.platforms ?? [],
    description: wf.description ?? '',
    tags: wf.tags ?? [],
    triggers: wf.triggers ?? [],
    parameters: wf.parameters ?? [],
    preconditions: wf.preconditions ?? [],
    steps,
    expected_results: wf.expected_results ?? [],
    failure_modes: wf.failure_modes ?? [],
    notes: wf.notes ?? [],
    stats: { runs: 0, successes: 0, failures: 0, last_success: null, last_failure: null, last_verified: null, last_failure_reason: null, ...(wf.stats || {}) },
    version: wf.version ?? 1,
    history: wf.history ?? [],
    source: wf.source ?? 'learned',
    created: wf.created ?? new Date().toISOString(),
    updated: wf.updated ?? new Date().toISOString(),
  };
}

/** Replace {{param}} placeholders (in strings, recursively) with parameter values. */
export function substitute(value, params) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (whole && params[whole[1]] !== undefined) return params[whole[1]]; // keep non-string types
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, params);
    return out;
  }
  return value;
}

export function resolveParams(wf, given = {}) {
  const params = {};
  const missing = [];
  for (const p of wf.parameters || []) {
    if (given[p.name] !== undefined) params[p.name] = given[p.name];
    else if (p.default !== undefined) params[p.name] = p.default;
    else if (p.required !== false) missing.push(p.name);
  }
  for (const [k, v] of Object.entries(given)) if (params[k] === undefined) params[k] = v;
  if (missing.length) {
    throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Missing workflow parameters: ${missing.join(', ')}`, {
      details: { parameters: wf.parameters },
    });
  }
  return params;
}

/** Find leftover {{placeholders}} after substitution. */
export function unresolvedPlaceholders(value) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}
