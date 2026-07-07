import { MySQLConnector } from './MySQLConnector.js';
import { MySQLError } from './MySQLError.js';

/**
 * Manages multiple named MySQLConnector instances. Use this when a single
 * service needs to talk to multiple databases — e.g. one for app data,
 * one for reporting, one read-replica.
 *
 * Each config must have an `id` field; that's the key you'll pass to query().
 */
export class MySQLConnections {
  /**
   * @param {Array<object>} configs — array of mysql2 pool configs, each with an `id`
   * @param {object} [options]
   * @param {object} [options.logger]
   * @param {number} [options.defaultQueryTimeoutMs]
   */
  constructor(configs = [], options = {}) {
    if (!Array.isArray(configs)) {
      throw new TypeError('MySQLConnections expects an array of configs');
    }
    this.creationTimestamp = new Date();
    this.logger = options.logger || null;
    this.connectors = new Map();

    for (const config of configs) {
      if (!config || !config.id) {
        throw new TypeError('Each config must have an "id" field');
      }
      if (this.connectors.has(config.id)) {
        throw new Error(`Duplicate connector id: ${config.id}`);
      }
      this.connectors.set(
        config.id,
        new MySQLConnector(config.id, config, {
          logger: this.logger,
          defaultQueryTimeoutMs: options.defaultQueryTimeoutMs,
        })
      );
    }
  }

  /**
   * Get the connector for a given key. Throws MySQLError if not found.
   * Useful when you want to call .transaction() or .ping() directly.
   */
  get(key) {
    const connector = this.connectors.get(key);
    if (!connector) {
      throw new MySQLError(
        `No MySQL connector found for key "${key}". Known keys: ${[...this.connectors.keys()].join(', ') || '(none)'}`,
        this.logger
      );
    }
    return connector;
  }

  /**
   * Convenience: run a query against the named connector.
   * Errors propagate as thrown MySQLError (consistent with MySQLConnector.query).
   */
  async query(key, sqlOrOptions, params = [], opts = {}) {
    return this.get(key).query(sqlOrOptions, params, opts);
  }

  /**
   * Convenience: call a stored procedure against the named connector.
   */
  async sproc(key, sprocName, params = [], opts = {}) {
    return this.get(key).sproc(sprocName, params, opts);
  }

  /**
   * Convenience: run a transaction against the named connector.
   */
  async transaction(key, callback) {
    return this.get(key).transaction(callback);
  }

  /**
   * Health-check all configured connectors. Returns an object mapping
   * key -> boolean. Useful for /health endpoints.
   */
  async pingAll(timeoutMs = 5000) {
    const results = {};
    await Promise.all(
      [...this.connectors.entries()].map(async ([key, connector]) => {
        results[key] = await connector.ping(timeoutMs);
      })
    );
    return results;
  }

  /**
   * Collect pool metrics from every connector. Suitable for /metrics endpoints.
   */
  getMetrics() {
    return [...this.connectors.values()].map((c) => c.getMetrics());
  }

  /**
   * Gracefully close all pools. Call on SIGTERM/SIGINT.
   * Safe to call multiple times.
   */
  async closeAll() {
    await Promise.all(
      [...this.connectors.values()].map((c) => c.close())
    );
  }
}
