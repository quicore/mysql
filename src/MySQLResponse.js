import { randomUUID } from 'crypto';

/**
 * Base class for MySQL responses. Holds shared metadata
 * (supportId, timestamp, sql, fields) that both success and error
 * responses carry. Not intended to be instantiated directly.
 */
export class MySQLResponse {
  constructor(logger = null) {
    this.hasError = false;
    this.logger = logger || null;
    this.results = null;
    this.fields = null;
    this.supportId = randomUUID();
    this.timestamp = new Date();
    this.sql = '';
    this.params = null;
    this.durationMs = null;
  }

  setSQL(sql) {
    this.sql = sql;
    return this;
  }

  setParams(params) {
    // Defensive copy so the response object isn't entangled with caller-mutable arrays.
    this.params = Array.isArray(params) ? [...params] : params;
    return this;
  }

  setFields(fields) {
    this.fields = fields;
    return this;
  }

  setResult(results) {
    this.results = results;
    return this;
  }

  setDuration(ms) {
    this.durationMs = ms;
    return this;
  }

  setError(error) {
    this.hasError = true;
    if (error instanceof MySQLResponse) {
      // Copy over fields if we're wrapping another response (e.g. MySQLError wrapping MySQLError)
      this.error = error.error;
      this.supportId = error.supportId;
      this.timestamp = error.timestamp;
      this.sql = error.sql;
      this.params = error.params;
    } else if (error instanceof Error) {
      this.error = {
        message: error.message,
        name: error.name,
      };
      // Each property is now correctly checked against itself (was a copy-paste bug
      // in the original — every branch checked error.code).
      if (error.code !== undefined) this.error.code = error.code;
      if (error.errno !== undefined) this.error.errno = error.errno;
      if (error.sqlState !== undefined) this.error.sqlState = error.sqlState;
      if (error.fatal !== undefined) this.error.fatal = error.fatal;
      if (error.timeout !== undefined) this.error.timeout = error.timeout;
    } else if (typeof error === 'string') {
      this.error = { message: error };
    } else {
      this.error = error;
    }
    return this;
  }

  toJSON() {
    const response = {
      hasError: this.hasError,
      timestamp: this.timestamp,
      supportId: this.supportId,
      sql: this.sql,
      durationMs: this.durationMs,
    };
    if (this.hasError) {
      response.error = this.error;
    } else {
      response.results = this.results;
      response.fields = this.fields;
    }
    return response;
  }
}
