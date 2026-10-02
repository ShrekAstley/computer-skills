import { CHECK_TYPES } from '../verify/checks.js';
import { classifyUiTarget, maxRisk } from '../safety/classifier.js';
import { resolveWindow, hasSelector } from '../apps/windows.js';

export const WINDOW_PROPS = {
  window_id: { type: 'string', description: 'Exact window id from window list.' },
  title: { type: 'string', description: 'Window title (fuzzy match).' },
  title_regex: { type: 'string', description: 'Regex matched against the window title.' },
  app: { type: 'string', description: 'Application/process name that owns the window.' },
  pid: { type: 'integer', description: 'Owning process id.' },
};

export const REGION = {
  type: 'object',
  description: 'Screen rectangle in logical screen coordinates.',
  properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 } },
  required: ['x', 'y', 'width', 'height'],
};

export const CHECK = {
  type: 'object',
  description:
    'An observable condition. {"type": <one of the types below>, ...fields}. Types: ' +
    Object.entries(CHECK_TYPES).map(([k, v]) => `${k}: ${v}`).join('; ') +
    '. Window-related checks accept window_id/title/title_regex/app/pid.',
  properties: { type: { type: 'string', enum: Object.keys(CHECK_TYPES) } },
  required: ['type'],
};

export function windowSelector(args) {
  const sel = {};
  for (const k of Object.keys(WINDOW_PROPS)) if (args[k] !== undefined && args[k] !== null && args[k] !== '') sel[k] = args[k];
  return sel;
}

export const assessment = (risk = 'low', reasons = [], categories = []) => ({ risk, reasons, categories });

/** Blocked-app policy check for a window/app target. */
export async function blockedAppRisk(rt, { app, selector }) {
  const list = rt.config.safety.blockedApps || [];
  if (!list.length) return null;
  if (app && rt.policy.isBlockedApp(app)) return assessment('forbidden', [`"${app}" is on the blockedApps list`], ['blocked-app']);
  try {
    const w = await resolveWindow(rt.backend, hasSelector(selector) ? selector : null, { required: false });
    if (w && (rt.policy.isBlockedApp(w.app) || rt.policy.isBlockedApp(w.title))) {
      return assessment('forbidden', [`window "${w.title}" (${w.app}) belongs to a blocked app`], ['blocked-app']);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Risk of acting on a UI target identified by text or element handle. */
export function uiTargetRisk(rt, { text, element, extra }) {
  let label = text;
  if (!label && element) {
    try {
      label = rt.ui.elements.get(element).name;
    } catch {
      label = null;
    }
  }
  const a = classifyUiTarget(label);
  if (extra) {
    a.risk = maxRisk(a.risk, extra.risk);
    a.reasons.push(...(extra.reasons || []));
  }
  return a;
}

export function imageResult(meta, png, includeImage = true) {
  const res = {
    screenshot_id: meta.id,
    path: meta.path,
    image_size: [meta.width, meta.height],
    region: meta.region,
    scale: Math.round(meta.scale * 10000) / 10000,
    coordinates: meta.scale === 1 && meta.region.x === 0 && meta.region.y === 0
      ? 'Image pixels equal screen coordinates.'
      : `screen_x = ${meta.region.x} + image_x / ${Math.round(meta.scale * 10000) / 10000}; screen_y = ${meta.region.y} + image_y / ${Math.round(meta.scale * 10000) / 10000}. Or pass screenshot_id with image coordinates to input_mouse.`,
  };
  if (includeImage) res.__image = png;
  return res;
}
