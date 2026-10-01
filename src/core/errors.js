/**
 * Structured errors. Every failure surfaced to an agent carries a stable code,
 * a human message, an optional hint describing how to recover, and whether a
 * retry/recovery is plausible. Agents branch on `code`, humans read `message`.
 */

export const ErrorCode = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED', // OS-level permission (e.g. macOS Accessibility)
  POLICY_DENIED: 'POLICY_DENIED', // blocked by the safety policy
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED', // needs explicit human approval
  KILL_SWITCH: 'KILL_SWITCH', // user engaged the stop switch / failsafe
  UNSUPPORTED: 'UNSUPPORTED', // not possible on this platform/session
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING', // a helper binary is not installed
  BACKEND_FAILED: 'BACKEND_FAILED', // the OS mechanism returned an error
  APP_NOT_RUNNING: 'APP_NOT_RUNNING',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  CANCELLED: 'CANCELLED',
  INTERNAL: 'INTERNAL',
});

const RECOVERABLE = new Set([
  ErrorCode.TIMEOUT,
  ErrorCode.NOT_FOUND,
  ErrorCode.BACKEND_FAILED,
  ErrorCode.APP_NOT_RUNNING,
  ErrorCode.VERIFICATION_FAILED,
  ErrorCode.CONFIRMATION_REQUIRED,
  ErrorCode.DEPENDENCY_MISSING,
]);

export class ToolError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message
   * @param {{hint?: string, details?: object, recoverable?: boolean, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'ToolError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
    this.recoverable = opts.recoverable ?? RECOVERABLE.has(code);
  }

  toJSON() {
    const out = { code: this.code, message: this.message, recoverable: this.recoverable };
    if (this.hint) out.hint = this.hint;
    if (this.details) out.details = this.details;
    return out;
  }
}

/** Normalise anything thrown into a ToolError. */
export function toToolError(err) {
  if (err instanceof ToolError) return err;
  if (err && typeof err === 'object' && err.code === 'ENOENT') {
    return new ToolError(ErrorCode.NOT_FOUND, err.message, { cause: err });
  }
  if (err && typeof err === 'object' && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return new ToolError(ErrorCode.PERMISSION_DENIED, err.message, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ToolError(ErrorCode.INTERNAL, message, { cause: err, recoverable: false });
}

export const invalid = (message, details) => new ToolError(ErrorCode.INVALID_ARGUMENT, message, { details });
export const unsupported = (message, hint) => new ToolError(ErrorCode.UNSUPPORTED, message, { hint });
export const missingDependency = (what, hint) =>
  new ToolError(ErrorCode.DEPENDENCY_MISSING, `${what} is not available on this system`, { hint });
