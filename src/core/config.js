import { readJsonSync } from './fsutil.js';
import { statePaths, projectPaths } from './paths.js';
import { deepMerge } from './util.js';

export const SAFETY_LEVELS = ['restricted', 'normal', 'trusted'];
const LEVEL_ALIASES = { autonomous: 'trusted', strict: 'restricted', readonly: 'restricted', 'read-only': 'restricted', default: 'normal' };

export function normalizeLevel(level) {
  if (!level) return undefined;
  const l = String(level).toLowerCase().trim();
  const v = LEVEL_ALIASES[l] ?? l;
  return SAFETY_LEVELS.includes(v) ? v : undefined;
}

export const levelRank = (l) => SAFETY_LEVELS.indexOf(normalizeLevel(l) ?? 'normal');

export const DEFAULT_CONFIG = Object.freeze({
  safety: {
    level: 'normal',
    // A project's .computer-skills/config.json may only make the policy stricter
    // unless the user explicitly allows projects to escalate.
    allowProjectEscalation: false,
    // Extra protected paths (deleting/overwriting them is treated as critical).
    protectedPaths: [],
    // Regex strings. allow → treated as low risk; deny → always denied.
    allowCommands: [],
    denyCommands: [],
    // Apps the agent may never drive (matched case-insensitively against app/window names).
    blockedApps: [],
    // Confirmation tokens expire after this many seconds.
    confirmTtlSec: 300,
    // Ask the user through the MCP client (elicitation) when the client supports it.
    useElicitation: true,
    // Moving the mouse into the top-left corner (0,0) aborts any input action.
    failsafeCorner: true,
  },
  input: {
    typingDelayMs: 6,
    postActionDelayMs: 60,
    dragSteps: 12,
  },
  screen: {
    maxWidth: 1568,
    keepScreenshots: 60,
  },
  terminal: {
    defaultTimeoutMs: 120000,
    maxOutputChars: 30000,
    defaultShell: null, // auto
  },
  ocr: {
    engine: 'auto', // auto | tesseract | windows | vision | none
    language: 'eng',
    // Upscaling helps tiny anti-aliased text on some displays but hurts bitmap fonts; 1 is the safer default.
    upscale: 1,
  },
  workflows: {
    staleAfterDays: 90,
    extraDirs: [],
  },
  context: {
    maxAgeMinutes: 60,
  },
  logging: {
    level: 'info',
    file: true,
    stderr: true,
  },
});

/**
 * Load configuration: defaults ← user config ← project config (guarded) ← env.
 * Returns the merged config plus provenance so `safety status` can explain it.
 */
export function loadConfig(env = process.env) {
  const sp = statePaths(env);
  const pp = projectPaths(env);
  const sources = [];

  let userCfg = {};
  try {
    userCfg = readJsonSync(sp.config, {});
    if (Object.keys(userCfg).length) sources.push(sp.config);
  } catch (err) {
    sources.push(`${sp.config} (ignored: ${err.message})`);
  }

  let projectCfg = {};
  try {
    projectCfg = readJsonSync(pp.config, {});
    if (Object.keys(projectCfg).length) sources.push(pp.config);
  } catch (err) {
    sources.push(`${pp.config} (ignored: ${err.message})`);
  }

  let cfg = deepMerge(DEFAULT_CONFIG, userCfg);
  // Env var is set by the user (shell or MCP client config) → user-level authority.
  const envLevel = normalizeLevel(env.COMPUTER_SKILLS_LEVEL);
  if (envLevel) {
    cfg.safety.level = envLevel;
    sources.push('env:COMPUTER_SKILLS_LEVEL');
  }
  if (env.COMPUTER_SKILLS_LOG_LEVEL) cfg.logging.level = env.COMPUTER_SKILLS_LOG_LEVEL;
  if (env.COMPUTER_SKILLS_DEBUG === '1') cfg.logging.level = 'debug';

  cfg = applyProjectConfig(cfg, projectCfg);
  cfg.safety.level = normalizeLevel(cfg.safety.level) ?? 'normal';
  cfg._sources = sources;
  cfg._paths = { state: sp, project: pp };
  return cfg;
}

/** Merge a project config without letting it weaken the user's safety settings. */
export function applyProjectConfig(cfg, projectCfg) {
  if (!projectCfg || typeof projectCfg !== 'object') return cfg;
  const { safety: pSafety = {}, ...rest } = projectCfg;
  const out = deepMerge(cfg, rest);
  const s = { ...out.safety };
  const escalate = cfg.safety.allowProjectEscalation === true;
  const pLevel = normalizeLevel(pSafety.level);
  if (pLevel && (escalate || levelRank(pLevel) < levelRank(s.level))) s.level = pLevel;
  // Additive restrictions are always honoured.
  s.denyCommands = [...(s.denyCommands || []), ...(pSafety.denyCommands || [])];
  s.protectedPaths = [...(s.protectedPaths || []), ...(pSafety.protectedPaths || [])];
  s.blockedApps = [...(s.blockedApps || []), ...(pSafety.blockedApps || [])];
  if (escalate) s.allowCommands = [...(s.allowCommands || []), ...(pSafety.allowCommands || [])];
  if (pSafety.failsafeCorner === true) s.failsafeCorner = true;
  out.safety = s;
  return out;
}
