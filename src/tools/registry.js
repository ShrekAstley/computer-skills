import { ToolError, ErrorCode, toToolError } from '../core/errors.js';
import { shortId } from '../core/util.js';

/**
 * Tool definitions and the host that exposes them over MCP (or the CLI).
 *
 * Every call flows through the same pipeline:
 *   validate args → kill switch → risk assessment → policy (allow / confirm / deny)
 *   → handler → audit + recorder → MCP content (JSON text + optional images)
 *
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {object} inputSchema                  JSON Schema (object)
 * @property {boolean} [readOnly]                  never changes state
 * @property {boolean} [destructive]               may destroy data (hint for clients)
 * @property {boolean} [openWorld]                 touches things outside the computer (network)
 * @property {(args: object, rt: object) => Promise<{risk: string, reasons: string[], categories: string[]}>|object} [assess]
 * @property {(args: object) => string} [summary]  one-line human description for approvals/audit
 * @property {(args: object, rt: object, call: object) => Promise<object>} handler
 */

export function defineTool(def) {
  if (!def.name || !def.handler || !def.inputSchema) throw new Error(`invalid tool ${def.name}`);
  return def;
}

// ----------------------------------------------------------------- validation
/** Validate and coerce arguments against the JSON-schema subset we use. */
export function validateArgs(schema, value, where = 'arguments') {
  const errors = [];
  const out = check(schema, value, where, errors);
  if (errors.length) throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Invalid ${where}: ${errors.slice(0, 6).join('; ')}`, { details: { errors } });
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(schema, v, at, errors) {
  if (!schema || v === undefined) return v;
  if (schema.anyOf || schema.oneOf) {
    const alts = schema.anyOf || schema.oneOf;
    for (const alt of alts) {
      const e = [];
      const r = check(alt, v, at, e);
      if (!e.length) return r;
    }
    errors.push(`${at} does not match any allowed form`);
    return v;
  }
  let val = v;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  if (types) {
    let t = typeOf(val);
    // Lenient coercions for values clients commonly stringify.
    if (t === 'string' && (types.includes('number') || types.includes('integer')) && val.trim() !== '' && !Number.isNaN(Number(val))) {
      val = Number(val);
      t = typeOf(val);
    } else if (t === 'string' && types.includes('boolean') && (val === 'true' || val === 'false')) {
      val = val === 'true';
      t = 'boolean';
    } else if (t === 'string' && (types.includes('array') || types.includes('object')) && /^\s*[[{]/.test(val)) {
      try {
        val = JSON.parse(val);
        t = typeOf(val);
      } catch {
        /* leave */
      }
    }
    const ok = types.some((ty) => ty === t || (ty === 'number' && t === 'integer'));
    if (!ok) {
      errors.push(`${at} must be ${types.join(' or ')} (got ${t})`);
      return val;
    }
  }
  if (schema.enum && !schema.enum.includes(val)) errors.push(`${at} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof val === 'number') {
    if (schema.minimum !== undefined && val < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && val > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (typeof val === 'string' && schema.maxLength !== undefined && val.length > schema.maxLength) errors.push(`${at} is longer than ${schema.maxLength}`);
  if (Array.isArray(val) && schema.items) val = val.map((item, i) => check(schema.items, item, `${at}[${i}]`, errors));
  if (val && typeof val === 'object' && !Array.isArray(val) && schema.properties) {
    const out = { ...val };
    for (const req of schema.required || []) if (out[req] === undefined || out[req] === null) errors.push(`${at}.${req} is required`);
    for (const [k, sub] of Object.entries(schema.properties)) if (out[k] !== undefined && out[k] !== null) out[k] = check(sub, out[k], `${at}.${k}`, errors);
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(out)) if (!schema.properties[k]) errors.push(`${at}.${k} is not a known parameter`);
    }
    return out;
  }
  return val;
}

// --------------------------------------------------------------------- host
const CONFIRM_PROP = {
  type: 'string',
  description: 'Single-use approval token returned by a CONFIRMATION_REQUIRED error. Only pass it after the user explicitly approved this exact action.',
};

export class ToolHost {
  /**
   * @param {{tools: ToolDef[], rt: object}} opts
   */
  constructor({ tools, rt }) {
    this.rt = rt;
    this.tools = new Map();
    for (const t of tools) this.tools.set(t.name, t);
  }

  listTools() {
    return [...this.tools.values()].map((t) => {
      const schema = JSON.parse(JSON.stringify(t.inputSchema));
      schema.type = 'object';
      schema.properties = schema.properties || {};
      if (!t.readOnly) schema.properties.confirm = CONFIRM_PROP;
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: schema,
        annotations: {
          title: t.title,
          readOnlyHint: !!t.readOnly,
          destructiveHint: !!t.destructive,
          idempotentHint: !!t.readOnly,
          openWorldHint: !!t.openWorld,
        },
      };
    });
  }

  /**
   * Run a tool and return MCP `CallToolResult`.
   * @param {string} name
   * @param {object} rawArgs
   * @param {{signal?: AbortSignal, elicit?: Function}} [mcp]
   */
  async callTool(name, rawArgs, mcp = {}) {
    try {
      const result = await this.invoke(name, rawArgs, { ...mcp, via: 'client' });
      return formatResult(result);
    } catch (err) {
      const e = toToolError(err);
      if (e.code === ErrorCode.INTERNAL) this.rt.logger?.error?.('tool failed', { tool: name, error: String(err?.stack || err) });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.toJSON() }) }] };
    }
  }

  /** Invoke a tool and return its raw result object (used by the workflow runner too). */
  async invoke(name, rawArgs = {}, call = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(ErrorCode.NOT_FOUND, `Unknown tool "${name}"`, { details: { tools: [...this.tools.keys()] } });
    const rt = this.rt;
    const trace = shortId('t-');
    const started = Date.now();
    const schema = { ...tool.inputSchema, type: 'object', properties: { ...(tool.inputSchema.properties || {}), confirm: CONFIRM_PROP } };
    const args = validateArgs(schema, rawArgs ?? {}, `${name} arguments`);

    if (!tool.readOnly && rt.policy.isStopped()) {
      throw new ToolError(ErrorCode.KILL_SWITCH, 'Automation is paused: the kill switch is engaged', {
        hint: `The user created ${rt.paths.stopFile}. Stop and ask the user. They resume with \`computer-skills resume\` (or by deleting the file).`,
        recoverable: false,
      });
    }

    let assessment = { risk: tool.readOnly ? 'safe' : 'low', reasons: [], categories: [] };
    if (tool.assess) assessment = { ...assessment, ...(await tool.assess(args, rt)) };
    const summary = tool.summary ? tool.summary(args) : `${name} ${JSON.stringify(stripConfirm(args)).slice(0, 160)}`;
    await rt.policy.enforce({ tool: name, args, assessment, summary, elicit: call.elicit });

    const log = rt.logger?.child?.({ trace, tool: name }) ?? rt.logger;
    log?.debug?.('call', { via: call.via, risk: assessment.risk });
    let result;
    try {
      result = await tool.handler(args, rt, { ...call, trace, assessment, log });
    } catch (err) {
      const e = toToolError(err);
      log?.info?.('tool error', { code: e.code, message: e.message, ms: Date.now() - started });
      throw e;
    }
    const ms = Date.now() - started;
    log?.info?.('ok', { ms, via: call.via });
    if (call.via !== 'workflow' && call.via !== 'workflow-recovery') rt.recorder?.observe(name, stripConfirm(args), result);
    return result;
  }
}

function stripConfirm(args) {
  const { confirm, ...rest } = args || {};
  return rest;
}

/** Convert a handler result into MCP content blocks. */
export function formatResult(result) {
  const content = [];
  const images = [];
  let data = result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const { __image, __images, ...rest } = result;
    if (__image) images.push({ data: __image, mimeType: 'image/png' });
    if (__images) images.push(...__images);
    data = rest;
  }
  content.push({ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) });
  for (const img of images) {
    content.push({ type: 'image', data: Buffer.isBuffer(img.data) ? img.data.toString('base64') : img.data, mimeType: img.mimeType || 'image/png' });
  }
  return { content };
}
