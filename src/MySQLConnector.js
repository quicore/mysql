import path from 'path';
import fs from 'fs';
import mysql from 'mysql2/promise';
import mysqlSync from 'mysql2'; // for the synchronous .format() helper
import { MySQLError } from './MySQLError.js';
import { MySQLResults } from './MySQLResults.js';

/**
 * Default pool options. Caller config overrides these.
 *
 * Rationale:
 *  - connectionLimit: 10        — conservative default; tune per service
 *  - waitForConnections: true   — queue rather than dropping under load
 *  - queueLimit: 0              — unbounded queue; pair with per-query timeouts
 *  - enableKeepAlive: true      — survive NAT/firewall idle reaping on AWS
 *  - keepAliveInitialDelay: 10s — start keepalive after 10s idle
 *  - connectTimeout: 10s        — fail fast if DB is unreachable
 *  - idleTimeout: 60s           — release idle conns back to the quota
 *  - maxIdle: same as limit     — let pool fully drain when idle (override if you want warm conns)
 *  - dateStrings: true          — avoid JS Date timezone footguns
 *  - namedPlaceholders: true    — enables :name placeholders in addition to ?
 */
const DEFAULT_POOL_OPTIONS = {
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  connectTimeout: 10_000,
  idleTimeout: 60_000,
  dateStrings: true,
  namedPlaceholders: true,
};

/**
 * MySQLConnector wraps a single mysql2 connection pool with:
 *   - sane production defaults (keep-alive, timeouts, queueing)
 *   - parameterized queries and stored procedures
 *   - transaction support
 *   - graceful shutdown
 *   - pool metrics
 *   - per-query timeout
 *   - structured error responses (throws MySQLError on failure)
 */
export class MySQLConnector {
  /**
   * @param {string} id — unique identifier for this connector (used in logs/metrics)
   * @param {object} config — mysql2 pool config; merged on top of DEFAULT_POOL_OPTIONS
   * @param {object} [options]
   * @param {object} [options.logger] — logger with .log({message, level}) method
   * @param {number} [options.defaultQueryTimeoutMs=30000] — per-query timeout default
   */
  constructor(id, config = {}, options = {}) {
    if (!id) throw new TypeError('MySQLConnector requires an id');

    this.creationTimestamp = new Date();
    this.id = id;
    this.config = config;
    this.logger = options.logger || null;
    this.defaultQueryTimeoutMs = options.defaultQueryTimeoutMs ?? 30_000;
    this.pool = null;
    this.closed = false;
  }

  setLogger(logger) {
    this.logger = logger;
    return this;
  }

  log(message, level = 'info', extra = {}) {
    const payload = { message, level, connectorId: this.id, ...extra };
    if (this.logger && typeof this.logger.log === 'function') {
      this.logger.log(payload);
    } else if (level === 'error') {
      console.error(payload);
    } else {
      console.log(payload);
    }
  }

  /**
   * Lazily creates the underlying mysql2 pool. Safe to call repeatedly.
   * SSL files (ca/key/cert) are loaded once and cached.
   */
  getPool() {
    if (this.closed) {
      throw new MySQLError(`Connector "${this.id}" has been closed`, this.logger);
    }
    if (this.pool) return this.pool;

    try {
      const sslConfig = this.config.ssl || null;
      let sslOptions;

      if (sslConfig && typeof sslConfig === 'object') {
        sslOptions = { ...sslConfig };
        // Resolve any file-path references to buffers (one-time read).
        for (const key of ['ca', 'cert', 'key']) {
          if (typeof sslConfig[key] === 'string' && sslConfig[key].includes('-----BEGIN') === false) {
            // Treat as file path
            sslOptions[key] = fs.readFileSync(path.resolve(sslConfig[key]));
          }
        }
      }

      // IMPORTANT: caller config wins over defaults.
      // The original code had `{ ...this.config, connectionLimit: 10 }` which
      // overrode whatever the caller passed. Spreading defaults first is the fix.
      const poolOptions = {
        ...DEFAULT_POOL_OPTIONS,
        ...this.config,
      };
      if (sslOptions) poolOptions.ssl = sslOptions;

      // Tag connections so they're identifiable in SHOW PROCESSLIST / performance_schema.
      poolOptions.connectAttributes = {
        ...(poolOptions.connectAttributes || {}),
        program_name: this.id,
      };

      this.pool = mysql.createPool(poolOptions);
      this.log(`Pool created for connector "${this.id}"`, 'info', {
        connectionLimit: poolOptions.connectionLimit,
      });
    } catch (error) {
      const err = new MySQLError(error, this.logger);
      this.log(`Failed to create pool: ${err.message}`, 'error');
      throw err;
    }

    return this.pool;
  }

  /**
   * Execute a parameterized SQL query.
   *
   * @param {string|object} sqlOrOptions — SQL string, or mysql2 options object
   *                                       (e.g. { sql, nestTables: true, timeout })
   * @param {Array|object} [params] — positional (array) or named (object) parameters
   * @param {object} [opts]
   * @param {boolean} [opts.logSQL=false] — log the rendered SQL (off by default; queries log on error always)
   * @param {number} [opts.timeoutMs] — per-query timeout; falls back to defaultQueryTimeoutMs
   * @returns {Promise<MySQLResults>}
   * @throws {MySQLError}
   */
  async query(sqlOrOptions, params = [], opts = {}) {
    const pool = this.getPool();
    const logSQL = opts.logSQL ?? false;
    const timeoutMs = opts.timeoutMs ?? this.defaultQueryTimeoutMs;

    // Normalize: support both query('SELECT ...', [..]) and query({ sql, nestTables }, [..])
    const queryOptions =
      typeof sqlOrOptions === 'string'
        ? { sql: sqlOrOptions }
        : { ...sqlOrOptions };

    if (timeoutMs && !queryOptions.timeout) {
      queryOptions.timeout = timeoutMs;
    }

    // For diagnostics we render the fully-formatted SQL using mysql2's
    // own escaper — same logic the driver uses, so it's safe and accurate.
    // Note: This is for *display only*. The actual execution uses
    // parameterized queries below.
    let renderedSql = queryOptions.sql;
    try {
      renderedSql = mysqlSync.format(queryOptions.sql, params);
    } catch {
      // Formatting is best-effort; never let it block execution.
    }

    if (logSQL) {
      this.log(`Executing query: ${renderedSql}`);
    }

    const startedAt = process.hrtime.bigint();
    try {
      const [results, fields] = await pool.query(queryOptions, params);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      return new MySQLResults(results, this.logger)
        .setSQL(renderedSql)
        .setParams(params)
        .setFields(fields)
        .setDuration(durationMs);
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const err = new MySQLError(error, this.logger)
        .setSQL(renderedSql)
        .setParams(params)
        .setDuration(durationMs);
      this.log(`Query failed: ${err.message}`, 'error', { supportId: err.supportId });
      throw err;
    }
  }

  /**
   * Execute a stored procedure with proper parameterization.
   *
   * @param {string} sprocName — name of the stored procedure
   * @param {Array} [params] — parameters (always parameterized, never interpolated)
   * @param {object} [opts]
   * @param {boolean} [opts.nestTables=false] — nest table prefixes in result columns
   * @returns {Promise<MySQLResults>}
   * @throws {MySQLError}
   */
  async sproc(sprocName, params = [], opts = {}) {
    if (!sprocName || typeof sprocName !== 'string') {
      throw new MySQLError('Stored procedure name is required and must be a string', this.logger);
    }
    // Validate the sproc name to prevent injection through the identifier.
    // MySQL identifiers can contain letters, digits, $, _ and dots (for schema-qualified names).
    if (!/^[A-Za-z0-9_$.]+$/.test(sprocName)) {
      throw new MySQLError(
        `Invalid stored procedure name: ${sprocName}`,
        this.logger
      );
    }

    const placeholders = Array.isArray(params) && params.length > 0
      ? params.map(() => '?').join(', ')
      : '';
    const sql = `CALL \`${sprocName.replace(/\./g, '`.`')}\`(${placeholders})`;
    const queryOpts = opts.nestTables ? { sql, nestTables: true } : sql;

    // CALL with result-producing procedures returns [resultSets, okPacket].
    // We surface the *first* result set as `.results` and stash the rest on `.resultSets`.
    const result = await this.query(queryOpts, params);
    if (Array.isArray(result.results) && Array.isArray(result.results[0])) {
      const allSets = result.results;
      result.resultSets = allSets;
      result.results = allSets[0]; // first set is the most common case
    }
    return result;
  }

  /**
   * Run a function inside a transaction. The function receives a `tx` object
   * with .query() and .sproc() methods that are bound to a single dedicated
   * connection. Commits on success, rolls back on any thrown error.
   *
   * @example
   *   await connector.transaction(async (tx) => {
   *     await tx.query('INSERT INTO orders ...', [...]);
   *     await tx.query('UPDATE inventory ...', [...]);
   *   });
   */
  async transaction(callback) {
    const pool = this.getPool();
    const conn = await pool.getConnection();
    const tx = {
      query: async (sqlOrOpts, params = [], opts = {}) => {
        const queryOptions =
          typeof sqlOrOpts === 'string' ? { sql: sqlOrOpts } : { ...sqlOrOpts };
        if (opts.timeoutMs) queryOptions.timeout = opts.timeoutMs;
        const startedAt = process.hrtime.bigint();
        try {
          const [results, fields] = await conn.query(queryOptions, params);
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          let renderedSql = queryOptions.sql;
          try { renderedSql = mysqlSync.format(queryOptions.sql, params); } catch {}
          return new MySQLResults(results, this.logger)
            .setSQL(renderedSql)
            .setParams(params)
            .setFields(fields)
            .setDuration(durationMs);
        } catch (error) {
          let renderedSql = queryOptions.sql;
          try { renderedSql = mysqlSync.format(queryOptions.sql, params); } catch {}
          throw new MySQLError(error, this.logger)
            .setSQL(renderedSql)
            .setParams(params);
        }
      },
    };

    try {
      await conn.beginTransaction();
      const result = await callback(tx);
      await conn.commit();
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        this.log(`Rollback failed: ${rollbackError.message}`, 'error');
      }
      if (error instanceof MySQLError) throw error;
      throw new MySQLError(error, this.logger);
    } finally {
      conn.release();
    }
  }

  /**
   * Quick health check — returns true if SELECT 1 succeeds within the timeout.
   */
  async ping(timeoutMs = 5000) {
    try {
      await this.query('SELECT 1 AS ok', [], { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns pool metrics suitable for exporting to Prometheus / Datadog.
   * The underlying field names come from the mysql2 internals; if they
   * change between versions, this method shields callers from the churn.
   */
  getMetrics() {
    if (!this.pool) {
      return { connectorId: this.id, initialized: false };
    }
    // mysql2's PromisePool wraps the callback pool; reach in for stats.
    const innerPool = this.pool.pool || this.pool;
    return {
      connectorId: this.id,
      initialized: true,
      closed: this.closed,
      // These are mysql2 internals — best-effort across versions.
      totalConnections: innerPool._allConnections?.length ?? null,
      freeConnections: innerPool._freeConnections?.length ?? null,
      queuedRequests: innerPool._connectionQueue?.length ?? null,
      connectionLimit: innerPool.config?.connectionLimit ?? null,
    };
  }

  /**
   * Gracefully close the pool. After this, the connector cannot be reused.
   * Idempotent — safe to call multiple times.
   *
   * Call this on SIGTERM/SIGINT to avoid leaking connections during deploys.
   */
  async close() {
    if (this.closed || !this.pool) {
      this.closed = true;
      return;
    }
    try {
      await this.pool.end();
      this.log(`Pool closed for connector "${this.id}"`);
    } catch (error) {
      this.log(`Error closing pool: ${error.message}`, 'error');
    } finally {
      this.closed = true;
      this.pool = null;
    }
  }
}
