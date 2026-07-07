import { MySQLResponse } from './MySQLResponse.js';

/**
 * Represents the result of a successful MySQL operation.
 * Includes the result rows, field metadata, and execution stats.
 */
export class MySQLResults extends MySQLResponse {
  constructor(results, logger = null) {
    super(logger);
    this.setResult(results);
  }

  /**
   * Convenience: returns the first row, or null if no rows.
   * Useful for queries that should return a single row.
   */
  first() {
    if (Array.isArray(this.results) && this.results.length > 0) {
      return this.results[0];
    }
    return null;
  }

  /**
   * Convenience: returns the number of rows.
   */
  count() {
    return Array.isArray(this.results) ? this.results.length : 0;
  }
}
