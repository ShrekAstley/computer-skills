import { versionSatisfies } from '../core/util.js';

/**
 * Reliability model for learned workflows.
 *
 * base       = Laplace-smoothed success rate (s + 1) / (n + 2), so a brand new
 *              workflow starts at 0.5 and a single success gives 0.67.
 * staleness  = halves the score's distance above 0.5 once the workflow hasn't
 *              been verified for `staleAfterDays` (apps update; UIs drift).
 * recency    = a failure on the most recent run costs 0.15.
 * mismatch   = different OS or app version outside the declared range costs 0.2 each.
 *
 * Classification:
 *   known    confidence ≥ 0.65 (e.g. one verified success), verified, matches this environment
 *   partial  any other existing workflow (stale, failing, other OS/version, never verified)
 *   unknown  no workflow (the caller decides; an app profile may still exist)
 */
export function confidence(wf, { os, appVersion, now = Date.now(), staleAfterDays = 90 } = {}) {
  const s = wf.stats || {};
  const runs = s.runs || 0;
  const successes = s.successes || 0;
  let c = (successes + 1) / (runs + 2);
  const reasons = [];

  const verifiedAt = s.last_verified ? Date.parse(s.last_verified) : null;
  if (verifiedAt) {
    const days = (now - verifiedAt) / 86400000;
    if (days > staleAfterDays) {
      c = 0.5 + (c - 0.5) / 2;
      reasons.push(`last verified ${Math.round(days)} days ago`);
    }
  } else {
    reasons.push('never verified on this machine');
  }

  const lastFail = s.last_failure ? Date.parse(s.last_failure) : 0;
  const lastOk = s.last_success ? Date.parse(s.last_success) : 0;
  if (lastFail && lastFail > lastOk) {
    c -= 0.15;
    reasons.push('most recent run failed' + (s.last_failure_reason ? `: ${s.last_failure_reason}` : ''));
  }

  if (os && wf.platforms?.length && !wf.platforms.includes(os)) {
    c -= 0.2;
    reasons.push(`learned on ${wf.platforms.join('/')}, this is ${os}`);
  }
  if (appVersion && wf.app?.version && !versionSatisfies(appVersion, wf.app.version)) {
    c -= 0.2;
    reasons.push(`app version ${appVersion} is outside ${wf.app.version}`);
  } else if (appVersion && wf.app?.tested_version && String(wf.app.tested_version).split('.')[0] !== String(appVersion).split('.')[0]) {
    c -= 0.1;
    reasons.push(`tested with ${wf.app.tested_version}, installed ${appVersion}`);
  }

  c = Math.max(0, Math.min(1, c));
  const status = c >= 0.65 && verifiedAt && !reasons.some((r) => r.startsWith('learned on') || r.startsWith('app version')) ? 'known' : 'partial';
  return { confidence: Math.round(c * 100) / 100, status, reasons };
}
