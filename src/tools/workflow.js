import { defineTool } from './registry.js';
import { assessment } from './common.js';
import { need } from './terminal.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { osName } from '../platform/index.js';

export const workflowSearch = defineTool({
  name: 'workflow_search',
  title: 'Search learned workflows',
  description:
    'ALWAYS call this before operating an application for a task. Searches the persistent workflow memory (learned + project + built-in) by task description and/or app. ' +
    'Returns status: "known" (reliable, verified workflow — run it), "partial" (a related/stale/failing workflow — run it carefully or use its steps as a guide), ' +
    'or "unknown" (explore the app; record what works). Each result has confidence, reasons, parameters, and last-verified date. Also reports what is known about the app itself.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The task, e.g. "export the project as png".' },
      app: { type: 'string', description: 'Restrict to an application.' },
      app_version: { type: 'string', description: 'Installed app version, to flag version mismatches.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    const res = await rt.workflows.search({ query: a.query ?? '', app: a.app, appVersion: a.app_version, os: osName(), limit: a.limit ?? 5 });
    if (a.app) {
      const profile = await rt.profiles.get(a.app).catch(() => null);
      res.app_knowledge = profile
        ? { app: profile.app, has_learned_profile: !!profile.learned, has_adapter: !!profile.adapter, scripting: profile.adapter?.scripting?.language }
        : undefined;
    }
    res.next =
      res.status === 'known'
        ? `Run it: workflow_run {"id": "${res.results[0].id}", "params": {...}}. Verify the outcome; the run updates its reliability.`
        : res.status === 'partial'
          ? 'Inspect it with workflow_get (or workflow_run dry_run) and run it with care; if a step fails, adapt and save an improved version.'
          : 'No workflow yet. Check app_profile for app knowledge, then explore: launch, screenshot, ui_inspect/ui_find, try the task step by step (consider workflow_record start), verify, and save it with workflow_save.';
    return res;
  },
});

export const workflowGet = defineTool({
  name: 'workflow_get',
  title: 'Get a workflow',
  description: 'Return a workflow document by id (steps, parameters, expectations, failure modes, stats, version history).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, include_history: { type: 'boolean' } },
    required: ['id'],
  },
  readOnly: true,
  async handler(a, rt) {
    const wf = await rt.workflows.get(a.id);
    const out = JSON.parse(JSON.stringify(wf));
    if (!a.include_history) delete out.history;
    out.scope = wf._scope;
    out.file = wf._file;
    return out;
  },
});

export const workflowRun = defineTool({
  name: 'workflow_run',
  title: 'Run a workflow',
  description:
    'Execute a saved workflow step by step. Each step\'s tool call goes through the normal safety policy; each step\'s `expect` checks are verified (with retries/recovery as defined). ' +
    'Outcomes: succeeded (stats updated), failed (stops at the failing step with diagnosis, screenshot and a recovery guide — adapt, finish the task, then workflow_save an improved version), ' +
    'paused (a manual step needs you; resume with start_at), blocked (needs user approval), precondition_failed. dry_run shows the resolved steps without doing anything.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      params: { type: 'object', description: 'Values for the workflow\'s {{parameters}}.' },
      start_at: { type: 'string', description: 'Resume from this step id.' },
      stop_after: { type: 'string', description: 'Stop after this step id.' },
      dry_run: { type: 'boolean' },
      record_outcome: { type: 'boolean', description: 'Update reliability stats (default true).' },
    },
    required: ['id'],
  },
  assess: () => assessment('low', ['each step is checked individually']),
  summary: (a) => `run workflow ${a.id}`,
  async handler(a, rt, call) {
    return rt.runner.run({ id: a.id, params: a.params || {}, startAt: a.start_at, stopAfter: a.stop_after, dryRun: a.dry_run, recordOutcome: a.record_outcome ?? true, signal: call.signal });
  },
});

export const workflowSave = defineTool({
  name: 'workflow_save',
  title: 'Save a workflow',
  description:
    'Persist a workflow you discovered or improved, so future sessions reuse it instead of exploring again. Saving an existing id creates a new version (old one archived). ' +
    'Set verified=true only if you just completed the task successfully with these steps. Shape: {"name","app":{"name","version?","tested_version?"},"description","triggers":[...],' +
    '"parameters":[{"name","description","required","default"}],"preconditions":[checks],"steps":[{"id","title","action":{"tool","args"} | "manual":"instruction","expect":[checks],"timeout_ms","retries","on_failure","hints":{"location","shortcut","notes"}}],' +
    '"expected_results":[checks],"failure_modes":[{"symptom","recovery"}],"notes":[...]}. Use {{param}} placeholders in args/checks. Prefer text targets over raw coordinates. ' +
    'scope "project" stores it in the repo (.computer-skills/workflows) to share with the team.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: { type: 'object', description: 'The workflow document.' },
      scope: { type: 'string', enum: ['user', 'project'] },
      change_note: { type: 'string', description: 'What changed and why (for updates).' },
      verified: { type: 'boolean', description: 'The task was just completed successfully with exactly these steps.' },
      reset_stats: { type: 'boolean', description: 'Reset reliability stats (use when the procedure changed fundamentally).' },
      merge: { type: 'boolean', description: 'Merge into the existing workflow instead of replacing it.' },
    },
    required: ['workflow'],
  },
  assess: () => assessment('low'),
  summary: (a) => `save workflow ${a.workflow?.name ?? a.workflow?.id}`,
  async handler(a, rt) {
    const wf = { ...a.workflow };
    if (!wf.platforms) wf.platforms = [osName()];
    const res = await rt.workflows.save(wf, { scope: a.scope ?? 'user', changeNote: a.change_note, verified: a.verified, resetStats: a.reset_stats, merge: a.merge });
    return { ...res, hint: res.created ? 'Saved. Next time, workflow_search will find it.' : `Updated to version ${res.version}; the previous version is archived (workflow_versions).` };
  },
});

export const workflowFeedback = defineTool({
  name: 'workflow_feedback',
  title: 'Report a workflow outcome',
  description:
    'Record whether a workflow worked when you executed it manually or resumed it mid-way (workflow_run records full runs automatically). Updates its reliability and last-verified date.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      success: { type: 'boolean' },
      reason: { type: 'string', description: 'Failure reason or note.' },
      step: { type: 'string', description: 'Failing step id.' },
      app_version: { type: 'string' },
    },
    required: ['id', 'success'],
  },
  assess: () => assessment('low'),
  async handler(a, rt) {
    return rt.workflows.recordOutcome(a.id, { success: a.success, reason: a.reason, step: a.step, appVersion: a.app_version, os: osName() });
  },
});

export const workflowRecord = defineTool({
  name: 'workflow_record',
  title: 'Record a workflow while learning',
  description:
    'Capture your actions while you work out how to do something in an app. "start" (name, app), then act normally — successful action-tool calls are recorded as steps and ' +
    'successful verify calls become the previous step\'s expectations; "annotate" adds a note to the last step; "status"; "stop" returns a draft workflow (not saved) with cleanup advice; "discard".',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status', 'annotate', 'discard'] },
      name: { type: 'string' },
      app: { type: 'string' },
      description: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['action'],
  },
  assess: () => assessment('low'),
  async handler(a, rt) {
    const r = rt.recorder;
    switch (a.action) {
      case 'start':
        return r.start({ name: a.name, app: a.app, description: a.description });
      case 'stop':
        return r.stop();
      case 'status':
        return r.status();
      case 'annotate':
        need(a, 'note');
        return r.annotate(a.note);
      case 'discard':
        return r.discard();
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export const workflowVersions = defineTool({
  name: 'workflow_versions',
  title: 'Workflow versions',
  description: 'Version management: "list" (history and archived versions), "restore" (roll back to `version`, creating a new version), "delete" (archive and remove a user/project workflow), "all" (list every stored workflow).',
  inputSchema: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['list', 'restore', 'delete', 'all'] }, id: { type: 'string' }, version: { type: 'integer', minimum: 1 } },
    required: ['action'],
  },
  assess: (a) => (a.action === 'list' || a.action === 'all' ? assessment('safe') : assessment('low')),
  async handler(a, rt) {
    switch (a.action) {
      case 'all': {
        const all = await rt.workflows.loadAll({ fresh: true });
        return {
          count: all.size,
          workflows: [...all.values()].map((w) => ({ id: w.id, name: w.name, app: w.app.name, version: w.version, scope: w._scope, runs: w.stats.runs, last_verified: w.stats.last_verified })),
          invalid_files: rt.workflows.problems?.length ? rt.workflows.problems : undefined,
        };
      }
      case 'list':
        need(a, 'id');
        return rt.workflows.versions(a.id);
      case 'restore':
        need(a, 'id', 'version');
        return rt.workflows.restore(a.id, a.version);
      case 'delete':
        need(a, 'id');
        return rt.workflows.remove(a.id);
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export const appProfile = defineTool({
  name: 'app_profile',
  title: 'App knowledge',
  description:
    'Knowledge about an application independent of any single task: built-in adapter knowledge (shortcuts, menus, scripting, pitfalls) plus what you learned before. ' +
    '"get" before exploring an app; "update" after learning something reusable (patch: {"shortcuts": {...}, "ui_map": {"<control>": {"location", "how"}}, "menus": {...}, "quirks": [...], "notes": [...], "version": "x.y"}); "list".',
  inputSchema: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['get', 'update', 'list'] }, app: { type: 'string' }, patch: { type: 'object' } },
    required: ['action'],
  },
  assess: (a) => (a.action === 'update' ? assessment('low') : assessment('safe')),
  async handler(a, rt) {
    switch (a.action) {
      case 'get': {
        need(a, 'app');
        const p = await rt.profiles.get(a.app);
        const wf = await rt.workflows.search({ app: a.app, limit: 20 }).catch(() => ({ results: [] }));
        p.workflows = wf.results.map((w) => ({ id: w.id, name: w.name, status: w.status }));
        return p;
      }
      case 'update':
        need(a, 'app', 'patch');
        return rt.profiles.update(a.app, a.patch);
      case 'list':
        return { profiles: await rt.profiles.list(), adapters: rt.adapters.list().map((x) => x.id) };
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});
