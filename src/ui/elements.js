import { shortId } from '../core/util.js';
import { ToolError, ErrorCode } from '../core/errors.js';

/**
 * Element handles. Accessibility nodes and OCR text hits are given short ids
 * ("el-3f2a9c") the agent can pass to ui_action / input_mouse. Handles carry
 * their screen bounds so they can always fall back to a coordinate click.
 */
export class ElementRegistry {
  constructor(max = 4000) {
    this.max = max;
    this.map = new Map();
  }

  add({ source, ref, x, y, width, height, name, role, window }) {
    const id = shortId('el-').slice(0, 9);
    const rec = { id, source, ref, name, role, window, at: Date.now() };
    if (width > 0 && height > 0) Object.assign(rec, { x, y, width, height });
    this.map.set(id, rec);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return rec;
  }

  get(id) {
    const rec = this.map.get(id);
    if (!rec) throw new ToolError(ErrorCode.NOT_FOUND, `Unknown element "${id}"`, { hint: 'Element ids expire when the server restarts or after many inspections. Run ui_find / ui_inspect again.' });
    return rec;
  }

  static center(rec) {
    if (rec.width === undefined) return null;
    return { x: Math.round(rec.x + rec.width / 2), y: Math.round(rec.y + rec.height / 2) };
  }
}

/** Convert a backend a11y tree into compact agent-facing nodes, registering handles. */
export function registerTree(nodes, registry, window, { flat = false, interactiveOnly = false } = {}) {
  const flatOut = [];
  const visit = (n, depth) => {
    const rec = registry.add({ source: 'a11y', ref: n.ref, x: n.x, y: n.y, width: n.width, height: n.height, name: n.name, role: n.role, window });
    const out = { el: rec.id, role: n.role };
    if (n.name) out.name = n.name;
    if (n.value !== undefined && n.value !== '') out.value = n.value;
    if (n.description) out.description = n.description;
    if (n.automationId) out.automationId = n.automationId;
    if (n.width > 0) out.bounds = [n.x, n.y, n.width, n.height];
    if (n.enabled === false) out.enabled = false;
    if (n.focused) out.focused = true;
    if (n.states?.length) out.states = n.states;
    if (n.toggled) out.toggled = n.toggled;
    if (n.actions?.length) out.actions = n.actions;
    if (n.childCount) out.more_children = n.childCount;
    const kids = (n.children || []).map((c) => visit(c, depth + 1)).filter(Boolean);
    if (flat) {
      const interesting = !interactiveOnly || isInteractive(n);
      if (interesting && (n.name || n.value || n.actions?.length)) flatOut.push({ ...out, depth });
      return null;
    }
    if (kids.length) out.children = kids;
    return out;
  };
  const tree = nodes.map((n) => visit(n, 0));
  return flat ? flatOut : tree;
}

const INTERACTIVE = /button|menu|item|link|check|radio|combo|edit|text|entry|field|tab|slider|spin|toggle|list|tree|cell|hyperlink|document/i;
export function isInteractive(n) {
  return INTERACTIVE.test(n.role || '') || (n.actions && n.actions.length > 0);
}

/** Flatten a tree for searching. */
export function flatten(nodes) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    (n.children || []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
