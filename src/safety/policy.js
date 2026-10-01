import fs from 'node:fs';
import { riskRank, maxRisk, defaultProtectedPaths } from './classifier.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { sha256, stableStringify, shortId } from '../core/util.js';
import { appendLine } from '../core/fsutil.js';
import path from 'node:path';

/**
 * Decision matrix: what happens to an action of a given risk at each safety level.
 *   allow   → run it
 *   confirm → a human must approve (MCP elicitation, or a single-use token the
 *             agent may only use after asking the user)
 *   deny    → refused at this level
 */
export const DECISIONS = Object.freeze({
  restricted: { safe: 'allow', low: 'confirm', medium: 'confirm', high: 'deny', critical: 'deny', forbidden: 'deny' },
  normal: { safe: 'allow', low: 'allow', medium: 'allow', high: 'confirm', critical: 'confirm', forbidden: 'deny' },
  trusted: { safe: 'allow', low: 'allow', medium: 'allow', high: 'allow', critical: 'confirm', forbidden: 'deny' },
});

export class SafetyPolicy {
  /**
   * @param {{config: object, logger?: object, auditFile?: string, stopFile?: string, now?: () => number}} opts
   */
  constructor({ config, logger, auditFile, stopFile, now = Date.now }) {
    this.config = config;
    this.logger = logger;
    this.auditFile = auditFile;
    this.stopFile = stopFile;
    this.now = now;
    this.tokens = new Map(); // token -> {hash, expires, summary}
    this.sessionApprovals = new Map(); // hash -> expires (approved via elicitation "for this session")
  }

  get level() {
    return this.config.safety.level;
  }

  get protectedPaths() {
    return [...defaultProtectedPaths(), ...(this.config.safety.protectedPaths || [])];
  }

  classifierOptions(extra = {}) {
    return {
      protectedPaths: this.protectedPaths,
      allowCommands: this.config.safety.allowCommands || [],
      denyCommands: this.config.safety.denyCommands || [],
      ...extra,
    };
  }

  /** Kill switch: a STOP file in the state directory halts every non read-only action. */
  isStopped() {
    try {
      return !!(this.stopFile && fs.existsSync(this.stopFile));
    } catch {
      return false;
    }
  }

  setStopped(stopped, reason = 'manual') {
    if (!this.stopFile) return;
    if (stopped) {
      fs.mkdirSync(path.dirname(this.stopFile), { recursive: true });
      fs.writeFileSync(this.stopFile, JSON.stringify({ reason, at: new Date().toISOString() }) + '\n');
    } else {
      fs.rmSync(this.stopFile, { force: true });
    }
  }

  isBlockedApp(name) {
    const list = this.config.safety.blockedApps || [];
    const n = String(name || '').toLowerCase();
    return !!n && list.some((b) => n.includes(String(b).toLowerCase()));
  }

  decide(risk) {
    return DECISIONS[this.level]?.[risk] ?? 'confirm';
  }

  actionHash(tool, args) {
    const { confirm, ...rest } = args || {};
    return sha256(tool + '\0' + stableStringify(rest));
  }

  issueToken(tool, args, assessment) {
    this._gc();
    const token = shortId('ok-');
    this.tokens.set(token, {
      hash: this.actionHash(tool, args),
      expires: this.now() + (this.config.safety.confirmTtlSec ?? 300) * 1000,
      tool,
      risk: assessment.risk,
    });
    return token;
  }

  /** Validate and consume a confirmation token for exactly this action. */
  consumeToken(token, tool, args) {
    this._gc();
    const rec = this.tokens.get(token);
    if (!rec) return { ok: false, reason: 'unknown or expired confirmation token' };
    if (rec.hash !== this.actionHash(tool, args)) return { ok: false, reason: 'confirmation token was issued for a different action (arguments changed)' };
    this.tokens.delete(token);
    return { ok: true };
  }

  approveForSession(tool, args, minutes = 30) {
    this.sessionApprovals.set(this.actionHash(tool, args), this.now() + minutes * 60000);
  }

  hasSessionApproval(tool, args) {
    const exp = this.sessionApprovals.get(this.actionHash(tool, args));
    return !!exp && exp > this.now();
  }

  _gc() {
    const t = this.now();
    for (const [k, v] of this.tokens) if (v.expires < t) this.tokens.delete(k);
    for (const [k, v] of this.sessionApprovals) if (v < t) this.sessionApprovals.delete(k);
  }

  /**
   * Gate an action. Resolves when it may proceed; throws ToolError otherwise.
   * @param {{tool: string, args: object, assessment: {risk: string, reasons: string[], categories: string[]}, summary: string,
   *          elicit?: (message: string) => Promise<'accept'|'accept_session'|'decline'|'unsupported'>}} req
   */
  async enforce({ tool, args, assessment, summary, elicit }) {
    const risk = assessment.risk;
    const decision = this.decide(risk);
    const base = { tool, risk, level: this.level, summary, reasons: assessment.reasons, categories: assessment.categories };

    if (decision === 'allow') {
      this.audit({ ...base, decision: 'allow' });
      return { decision: 'allow' };
    }
    if (decision === 'deny') {
      this.audit({ ...base, decision: 'deny' });
      const hint =
        risk === 'forbidden'
          ? 'This action is never performed by the agent. If it is truly intended, the user must run it themselves.'
          : `The current safety level is "${this.level}". The user can raise it (COMPUTER_SKILLS_LEVEL or ~/.computer-skills/config.json) or perform the action manually.`;
      throw new ToolError(ErrorCode.POLICY_DENIED, `Blocked by safety policy (${risk} risk at level ${this.level}): ${summary}`, {
        hint,
        recoverable: false,
        details: { risk, reasons: assessment.reasons, categories: assessment.categories },
      });
    }

    // confirm
    if (args?.confirm) {
      const r = this.consumeToken(args.confirm, tool, args);
      if (r.ok) {
        this.audit({ ...base, decision: 'confirmed-token' });
        return { decision: 'confirmed' };
      }
      this.audit({ ...base, decision: 'deny', note: r.reason });
      throw new ToolError(ErrorCode.POLICY_DENIED, `Confirmation rejected: ${r.reason}`, {
        hint: 'Call the tool again without `confirm` to obtain a fresh token, ask the user, then retry with the new token and identical arguments.',
        recoverable: true,
      });
    }
    if (this.hasSessionApproval(tool, args)) {
      this.audit({ ...base, decision: 'confirmed-session' });
      return { decision: 'confirmed' };
    }
    if (elicit && this.config.safety.useElicitation !== false) {
      const answer = await elicit(this.confirmationMessage(base));
      if (answer === 'accept' || answer === 'accept_session') {
        if (answer === 'accept_session') this.approveForSession(tool, args);
        this.audit({ ...base, decision: 'confirmed-elicitation' });
        return { decision: 'confirmed' };
      }
      if (answer === 'decline') {
        this.audit({ ...base, decision: 'declined-by-user' });
        throw new ToolError(ErrorCode.POLICY_DENIED, `The user declined: ${summary}`, {
          hint: 'Do not retry this action. Choose a different approach or ask the user how to proceed.',
          recoverable: false,
        });
      }
      // 'unsupported' / cancelled → fall through to token flow
    }
    const token = this.issueToken(tool, args, assessment);
    this.audit({ ...base, decision: 'confirmation-required' });
    throw new ToolError(ErrorCode.CONFIRMATION_REQUIRED, `Human approval required (${risk} risk): ${summary}`, {
      hint:
        `Ask the user to approve this exact action, quoting the summary and reasons. Only if they explicitly approve, call ${tool} again with identical arguments plus "confirm": "${token}". ` +
        `The token is single-use and expires in ${this.config.safety.confirmTtlSec ?? 300}s. Never use it without the user's approval.`,
      recoverable: true,
      details: { risk, reasons: assessment.reasons, categories: assessment.categories, confirm_token: token },
    });
  }

  confirmationMessage({ tool, risk, summary, reasons }) {
    return [
      `computer-skills wants to perform a ${risk.toUpperCase()}-risk action (${tool}):`,
      '',
      `  ${summary}`,
      '',
      reasons?.length ? `Why it needs approval: ${reasons.join('; ')}` : '',
      `Safety level: ${this.level}. Approve?`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  audit(entry) {
    const rec = { t: new Date(this.now()).toISOString(), ...entry };
    this.logger?.debug?.('policy', rec);
    if (!this.auditFile) return;
    appendLine(this.auditFile, JSON.stringify(rec)).catch(() => {});
  }

  /** Combine several assessments (e.g. command + target path). */
  static combine(...assessments) {
    const out = { risk: 'safe', reasons: [], categories: [] };
    for (const a of assessments.filter(Boolean)) {
      out.risk = maxRisk(out.risk, a.risk);
      for (const r of a.reasons || []) if (!out.reasons.includes(r)) out.reasons.push(r);
      for (const c of a.categories || []) if (!out.categories.includes(c)) out.categories.push(c);
    }
    return out;
  }

  static atLeast(assessment, risk, reason, category) {
    const out = { ...assessment, reasons: [...(assessment.reasons || [])], categories: [...(assessment.categories || [])] };
    if (riskRank(risk) > riskRank(out.risk)) out.risk = risk;
    if (reason) out.reasons.push(reason);
    if (category) out.categories.push(category);
    return out;
  }
}
