import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimal structured logger. MCP stdio servers must never write to stdout, so
 * everything goes to stderr (where clients surface server logs) and optionally
 * to a rotating-ish file under the state directory for post-mortem debugging.
 */
export class Logger {
  constructor({ level = 'info', file = null, stderr = true, maxFileBytes = 5 * 1024 * 1024, bindings = {} } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.file = file;
    this.stderr = stderr;
    this.maxFileBytes = maxFileBytes;
    this.bindings = bindings;
    this._stream = null;
  }

  child(bindings) {
    const c = Object.create(this);
    c.bindings = { ...this.bindings, ...bindings };
    return c;
  }

  setLevel(level) {
    if (LEVELS[level] !== undefined) this.level = LEVELS[level];
  }

  _fileStream() {
    if (!this.file) return null;
    if (this._stream) return this._stream;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        const st = fs.statSync(this.file);
        if (st.size > this.maxFileBytes) fs.renameSync(this.file, this.file + '.1');
      } catch {
        /* no previous log */
      }
      this._stream = fs.createWriteStream(this.file, { flags: 'a' });
      this._stream.on('error', () => {
        this.file = null;
        this._stream = null;
      });
    } catch {
      this.file = null;
    }
    return this._stream;
  }

  log(level, msg, fields) {
    if ((LEVELS[level] ?? 0) < this.level) return;
    const rec = { t: new Date().toISOString(), level, msg, ...this.bindings, ...(fields || {}) };
    let line;
    try {
      line = JSON.stringify(rec);
    } catch {
      line = JSON.stringify({ t: rec.t, level, msg });
    }
    if (this.stderr) process.stderr.write(`[computer-skills] ${line}\n`);
    const s = this._fileStream();
    if (s) s.write(line + '\n');
  }

  debug(msg, f) { this.log('debug', msg, f); }
  info(msg, f) { this.log('info', msg, f); }
  warn(msg, f) { this.log('warn', msg, f); }
  error(msg, f) { this.log('error', msg, f); }

  close() {
    if (this._stream) this._stream.end();
    this._stream = null;
  }
}

export const nullLogger = new Logger({ level: 'silent', stderr: false });
