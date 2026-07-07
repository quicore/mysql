import { MySQLResponse } from './MySQLResponse.js';

/**
 * Throwable MySQL error. Extends Error so it works with `throw` and
 * `instanceof Error`, while also carrying the MySQLResponse metadata
 * (supportId, timestamp, sql) for consistent error reporting.
 *
 * Note: We extend Error (not MySQLResponse) so it's a proper throwable,
 * and compose MySQLResponse-like fields onto it. The original design
 * extended MySQLResponse which meant `throw new MySQLError(...)` worked
 * but `err instanceof Error` was false — that broke a lot of middleware.
 */
export class MySQLError extends Error {
  constructor(error, logger = null) {
    // Resolve message before calling super so the Error stack trace is correct.
    let message;
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error.message === 'string') {
      message = error.message;
    } else {
      message = 'Unknown MySQL error';
    }
    super(message);

    this.name = 'MySQLError';
    this.hasError = true;
    this.logger = logger || null;

    // Build the same response-shaped metadata that MySQLResponse provides.
    // We delegate to a temporary MySQLResponse to keep the logic in one place.
    const meta = new MySQLResponse(logger).setError(error);
    this.supportId = meta.supportId;
    this.timestamp = meta.timestamp;
    this.error = meta.error;
    this.sql = '';
    this.params = null;
    this.durationMs = null;
    this.fields = null;
    this.results = null;

    // Preserve the original cause chain (Node 16.9+)
    if (error instanceof Error) {
      this.cause = error;
    }
  }

  setSQL(sql) {
    this.sql = sql;
    return this;
  }

  setParams(params) {
    this.params = Array.isArray(params) ? [...params] : params;
    return this;
  }

  setDuration(ms) {
    this.durationMs = ms;
    return this;
  }

  setFields(fields) {
    this.fields = fields;
    return this;
  }

  toJSON() {
    return {
      hasError: true,
      name: this.name,
      message: this.message,
      timestamp: this.timestamp,
      supportId: this.supportId,
      sql: this.sql,
      durationMs: this.durationMs,
      error: this.error,
    };
  }
}
