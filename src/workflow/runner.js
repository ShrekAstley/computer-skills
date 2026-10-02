import { ToolError, ErrorCode, toToolError } from '../core/errors.js';
import { substitute, resolveParams, unresolvedPlaceholders } from './schema.js';
import { verifyChecks } from '../verify/checks.js';

const STOPPING = new Set([ErrorCode.POLICY_DENIED, ErrorCode.CONFIRMATION_REQUIRED, ErrorCode.KILL_SWITCH, ErrorCode.CANCELLED, ErrorCode.PERMISSION_DENIED]);

/**
 * Deterministic workflow execution with per-step verification.
 *
 * The runner never improvises: when a step fails it stops with a precise
 * report (which step, what was expected, what was observed, a diagnosis and
 * a screenshot) so the *agent* can adapt — inspect, fix the UI path, finish
 * the task, and then save an improved version of the workflow. Manual steps
 * pause the run and hand an instruction back to the agent.
 */
export class WorkflowRunner {
  /**
   * @param {{store, callTool: (name: string, args: object, meta: object) => Promise<object>, checkCtx: () => object,
   *          diagnose: (opts: object) => Promise<object>, os: string, logger?: object}} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
  }

  async run({ id, params: given = {}, startAt, stopAfter, dryRun = false, recordOutcome = true, checkPreconditions = true, signal }) {
    const wf = await this.store.get(id);
    const params = resolveParams(wf, given);
    const steps = wf.steps.map((s) => substitute(s, params));
    const leftovers = unresolvedPlaceholders(steps);
    let startIdx = 0;
    if (startAt) {
      startIdx = steps.findIndex((s) => s.id === startAt);
      if (startIdx < 0) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `No step "${startAt}" in ${id}`, { details: { steps: steps.map((s) => s.id) } });
    }
    const stopIdx = stopAfter ? steps.findIndex((s) => s.id === stopAfter) : steps.length - 1;
    if (stopIdx < 0) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `No step "${stopAfter}" in ${id}`);

    const base = { workflow: id, name: wf.name, version: wf.version, app: wf.app.name };
    if (dryRun) {
      return {
        ...base,
        status: 'dry_run',
        params,
        unresolved_placeholders: leftovers.length ? leftovers : undefined,
        preconditions: substitute(wf.preconditions, params),
        steps: steps.map((s) => ({ id: s.id, title: s.title, action: s.action, manual: s.manual, expect: s.expect, hints: s.hints })),
        expected_results: substitute(wf.expected_results, params),
      };
    }
    if (leftovers.length) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unresolved placeholders: ${leftovers.join(', ')}`, { hint: 'Pass them in params.' });

    const started = Date.now();
    const ctx = { ...this.checkCtx(), startedAt: started };
    const report = [];

    if (checkPreconditions && startIdx === 0 && wf.preconditions?.length) {
      const pre = await verifyChecks(substitute(wf.preconditions, params), ctx, { timeoutMs: 2000, signal });
      if (!pre.ok) {
        return {
          ...base,
          status: 'precondition_failed',
          preconditions: pre.results,
          hint: 'Bring the environment into the required state first (e.g. launch the app, open the document), then run again. This does not count as a workflow failure.',
        };
      }
    }

    // Resuming right after a manual step: verify the manual step's expectations first.
    if (startIdx > 0 && steps[startIdx - 1].manual && steps[startIdx - 1].expect?.length) {
      const prev = steps[startIdx - 1];
      const v = await verifyChecks(prev.expect, ctx, { timeoutMs: prev.timeout_ms ?? 5000, signal });
      if (!v.ok) {
        return { ...base, status: 'failed', failed_step: prev.id, checks: v.results, hint: `The manual step "${prev.title ?? prev.id}" does not appear complete yet.` };
      }
    }

    for (let i = startIdx; i <= stopIdx; i++) {
      if (signal?.aborted) return { ...base, status: 'cancelled', steps: report };
      const step = steps[i];
      const entry = { id: step.id, title: step.title };
      report.push(entry);
      if (step.manual) {
        entry.status = 'paused';
        return {
          ...base,
          status: 'paused',
          steps: report,
          manual_step: { id: step.id, title: step.title, instruction: step.manual, hints: step.hints, expect: step.expect },
          resume: steps[i + 1] ? { start_at: steps[i + 1].id } : null,
          hint: steps[i + 1]
            ? `Perform this step yourself, then call workflow_run with start_at "${steps[i + 1].id}" (and the same params) to continue. Its expectations will be verified first.`
            : 'Perform this final step yourself, then verify the expected results and report the outcome with workflow_feedback.',
        };
      }
      const outcome = await this._runStep(step, ctx, signal, entry);
      if (outcome.stop) {
        const res = { ...base, status: outcome.status, steps: report, failed_step: step.id, error: outcome.error };
        if (outcome.checks) res.checks = outcome.checks;
        if (outcome.status === 'blocked') {
          res.hint = `Step "${step.id}" needs approval or was refused by policy. Ask the user; if they approve, perform the step with its tool directly (using the confirm token), then resume with start_at "${steps[i + 1]?.id ?? step.id}".`;
          return res;
        }
        res.diagnosis = await this.diagnose({ app: wf.app.name, includeScreenshot: true }).catch((e) => ({ error: e.message }));
        if (res.diagnosis?.__image) {
          res.__image = res.diagnosis.__image;
          delete res.diagnosis.__image;
        }
        res.recovery_guide = recoveryGuide(wf, step, outcome);
        if (recordOutcome) {
          res.stats = await this.store.recordOutcome(id, { success: false, reason: outcome.error?.message ?? 'expectation not met', step: step.id }).catch(() => undefined);
        }
        return res;
      }
    }

    // Partial runs (stop_after) don't verify final results or update stats.
    if (stopIdx < steps.length - 1) return { ...base, status: 'stopped', steps: report, next_step: steps[stopIdx + 1].id };

    let finalChecks;
    if (wf.expected_results?.length) {
      finalChecks = await verifyChecks(substitute(wf.expected_results, params), ctx, { timeoutMs: 10000, signal });
      if (!finalChecks.ok) {
        const res = { ...base, status: 'failed', steps: report, failed_step: 'expected_results', checks: finalChecks.results };
        res.recovery_guide = recoveryGuide(wf, { id: 'expected_results', title: 'final verification' }, { checks: finalChecks.results });
        if (recordOutcome) res.stats = await this.store.recordOutcome(id, { success: false, reason: 'expected results not met', step: 'expected_results' }).catch(() => undefined);
        return res;
      }
    }
    const res = { ...base, status: 'succeeded', duration_ms: Date.now() - started, steps: report };
    if (finalChecks) res.expected_results = finalChecks.results;
    if (recordOutcome && startIdx === 0) {
      res.stats = await this.store.recordOutcome(id, { success: true, os: this.os, durationMs: res.duration_ms, appVersion: given.__app_version }).catch(() => undefined);
    } else if (startIdx > 0) {
      res.note = 'Run resumed mid-way: call workflow_feedback to record the overall outcome.';
    }
    return res;
  }

  async _runStep(step, ctx, signal, entry) {
    const t0 = Date.now();
    const policy = step.on_failure ?? 'abort';
    const attempts = 1 + Math.max(0, Math.min(5, step.retries ?? (policy === 'retry' || policy === 'recover' ? 1 : 0)));
    let lastError = null;
    let lastChecks = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && step.recovery?.length) {
        for (const r of step.recovery) {
          if (r.action) await this.callTool(r.action.tool, r.action.args || {}, { via: 'workflow-recovery', step: step.id }).catch(() => {});
        }
      }
      try {
        if (step.action.tool.startsWith('workflow_')) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'Workflow steps cannot call workflow tools');
        const result = await this.callTool(step.action.tool, step.action.args || {}, { via: 'workflow', step: step.id, signal });
        entry.result = summarize(result);
        lastError = null;
        // Tools that report their own failure (exit codes, ok:false) fail the step even if it "ran".
        if (result && typeof result === 'object' && result.ok === false && step.action.tool !== 'verify') {
          lastError = new ToolError(ErrorCode.BACKEND_FAILED, `${step.action.tool} reported failure${result.exit_code !== undefined ? ` (exit code ${result.exit_code})` : ''}`, {
            details: { stderr_tail: tail(result.stderr), output_tail: tail(result.stdout ?? result.output) },
          });
          entry.attempts = attempt;
          if (step.expect?.length) lastChecks = (await verifyChecks(step.expect, ctx, { timeoutMs: 0, signal })).results;
          continue;
        }
      } catch (err) {
        const e = toToolError(err);
        lastError = e;
        if (STOPPING.has(e.code)) {
          entry.status = 'blocked';
          entry.error = e.toJSON();
          return { stop: true, status: e.code === ErrorCode.CANCELLED ? 'cancelled' : 'blocked', error: e.toJSON() };
        }
        entry.attempts = attempt;
        continue;
      }
      if (step.expect?.length) {
        const v = await verifyChecks(step.expect, ctx, { timeoutMs: step.timeout_ms ?? 10000, signal });
        lastChecks = v.results;
        if (!v.ok) {
          entry.attempts = attempt;
          continue;
        }
        entry.verified = true;
      }
      entry.status = 'ok';
      entry.duration_ms = Date.now() - t0;
      if (attempt > 1) entry.attempts = attempt;
      return { stop: false };
    }
    entry.status = 'failed';
    entry.duration_ms = Date.now() - t0;
    if (lastError) entry.error = lastError.toJSON();
    if (lastChecks) entry.checks = lastChecks;
    if (policy === 'continue') {
      entry.status = 'failed-continued';
      return { stop: false };
    }
    return { stop: true, status: 'failed', error: lastError?.toJSON() ?? { code: ErrorCode.VERIFICATION_FAILED, message: 'Step expectations were not met' }, checks: lastChecks };
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return result;
  const { __image, __images, ...rest } = result;
  const text = JSON.stringify(rest);
  if (text.length <= 600) return rest;
  // Keep the end of long strings: errors and tracebacks are at the bottom.
  const limit = result.ok === false ? 1500 : 200;
  return JSON.parse(JSON.stringify(rest, (k, v) => (typeof v === 'string' && v.length > limit ? '…' + v.slice(-limit) : v)));
}

function tail(text, n = 1500) {
  if (typeof text !== 'string' || !text) return undefined;
  return text.length > n ? '…' + text.slice(-n) : text;
}

function recoveryGuide(wf, step, outcome) {
  const known = (wf.failure_modes || []).map((f) => ({ symptom: f.symptom, recovery: f.recovery }));
  return {
    do_not: 'Do not re-run the same workflow unchanged.',
    steps: [
      'Read the diagnosis and screenshot: compare the actual screen with what this step expected.',
      known.length ? 'Check the known failure modes below — one may match.' : 'Determine what changed: different app version, moved/renamed control, unexpected dialog, focus lost, app crashed.',
      `Complete step "${step.title ?? step.id}" by other means (ui_find by text, menus, shortcuts, app_script), verifying each action.`,
      'Continue the remaining steps (workflow_run with start_at), or finish them manually.',
      'If you found a more reliable procedure, save it with workflow_save (same id, change_note explaining what changed, verified=true once the task succeeded).',
    ],
    known_failure_modes: known.length ? known : undefined,
    hints: step.hints,
  };
}
