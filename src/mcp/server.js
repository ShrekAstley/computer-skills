import { VERSION, SERVER_NAME } from '../version.js';

/**
 * Dependency-free Model Context Protocol server over stdio (newline-delimited
 * JSON-RPC 2.0). Implements the subset used by agent clients: lifecycle,
 * tools, ping, logging level, cancellation, and server→client elicitation for
 * human approval prompts.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const JSONRPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export class McpServer {
  /**
   * @param {{toolHost: {listTools(): object[], callTool(name: string, args: object, ctx: object): Promise<object>},
   *          logger?: object, instructions?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} opts
   */
  constructor({ toolHost, logger, instructions, input = process.stdin, output = process.stdout }) {
    this.toolHost = toolHost;
    this.logger = logger;
    this.instructions = instructions;
    this.input = input;
    this.output = output;
    this.clientCapabilities = {};
    this.clientInfo = null;
    this.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
    this.inflight = new Map(); // request id -> AbortController
    this.pending = new Map(); // our outgoing request id -> {resolve, reject, timer}
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
  }

  start() {
    this.input.setEncoding?.('utf8');
    this.input.on('data', (chunk) => this._onData(chunk));
    // On EOF, let in-flight calls finish (bounded) before shutting down.
    this.input.on('end', () => this.drainAndClose());
    this.input.on('error', () => this.close());
    return new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  async drainAndClose(timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const ac of this.inflight.values()) ac.abort(new Error('server closing'));
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('server closing'));
    }
    this._resolveClosed?.();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this._send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_ERRORS.PARSE, message: 'Parse error' } });
        continue;
      }
      if (Array.isArray(msg)) msg.forEach((m) => this._dispatch(m));
      else this._dispatch(msg);
    }
  }

  _send(msg) {
    if (this.closed && msg.method === undefined && msg.id === undefined) return;
    try {
      this.output.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      this.logger?.error?.('write failed', { error: String(err) });
    }
  }

  _dispatch(msg) {
    if (!msg || msg.jsonrpc !== '2.0') {
      if (msg && msg.id !== undefined) this._send({ jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }
    // Response to one of our requests (elicitation)
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'client error'), { rpc: msg.error }));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      this._onNotification(msg);
      return;
    }
    this._onRequest(msg).then(
      (result) => this._send({ jsonrpc: '2.0', id: msg.id, result }),
      (err) => {
        const code = err?.rpcCode ?? JSONRPC_ERRORS.INTERNAL;
        if (code === JSONRPC_ERRORS.INTERNAL) this.logger?.error?.('request failed', { method: msg.method, error: String(err?.stack || err) });
        this._send({ jsonrpc: '2.0', id: msg.id, error: { code, message: err?.message ?? String(err) } });
      },
    );
  }

  _onNotification(msg) {
    switch (msg.method) {
      case 'notifications/initialized':
        this.logger?.info?.('client initialized', { client: this.clientInfo, protocol: this.protocolVersion });
        break;
      case 'notifications/cancelled': {
        const ac = this.inflight.get(msg.params?.requestId);
        ac?.abort(new Error(msg.params?.reason || 'cancelled by client'));
        break;
      }
      default:
        break;
    }
  }

  async _onRequest(msg) {
    const params = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        this.clientCapabilities = params.capabilities || {};
        this.clientInfo = params.clientInfo || null;
        const requested = params.protocolVersion;
        this.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        const result = {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: SERVER_NAME, title: 'Computer Skills', version: VERSION },
        };
        if (this.instructions) result.instructions = this.instructions;
        return result;
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.toolHost.listTools() };
      case 'tools/call': {
        if (!params.name || typeof params.name !== 'string') throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'tools/call requires a tool name');
        const ac = new AbortController();
        this.inflight.set(msg.id, ac);
        try {
          return await this.toolHost.callTool(params.name, params.arguments || {}, {
            signal: ac.signal,
            elicit: this.supportsElicitation() ? (message) => this.elicitApproval(message, ac.signal) : undefined,
            protocolVersion: this.protocolVersion,
            client: this.clientInfo,
          });
        } finally {
          this.inflight.delete(msg.id);
        }
      }
      case 'logging/setLevel':
        this.logger?.setLevel?.(mapLogLevel(params.level));
        return {};
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw rpcError(JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  supportsElicitation() {
    return !!this.clientCapabilities?.elicitation;
  }

  /** Send a request to the client and await its response. */
  request(method, params, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
    const id = `srv-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener?.('abort', () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error('cancelled'));
        }
      }, { once: true });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Ask the human (through the client UI) to approve an action. */
  async elicitApproval(message, signal) {
    try {
      const res = await this.request(
        'elicitation/create',
        {
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                title: 'Decision',
                enum: ['approve_once', 'approve_session', 'deny'],
                enumNames: ['Approve once', 'Approve this exact action for 30 minutes', 'Deny'],
              },
            },
            required: ['decision'],
          },
        },
        { signal },
      );
      if (res?.action === 'accept') {
        const d = res.content?.decision;
        if (d === 'approve_once') return 'accept';
        if (d === 'approve_session') return 'accept_session';
        return 'decline';
      }
      if (res?.action === 'decline') return 'decline';
      return 'unsupported'; // cancel → fall back to token flow
    } catch (err) {
      this.logger?.warn?.('elicitation failed; falling back to confirmation token', { error: String(err?.message || err) });
      return 'unsupported';
    }
  }
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

function mapLogLevel(level) {
  switch (level) {
    case 'debug': return 'debug';
    case 'info': case 'notice': return 'info';
    case 'warning': return 'warn';
    default: return 'error';
  }
}
