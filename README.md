# @quicore/mysql

Production-grade MySQL connection pool helper for Node.js services. Wraps `mysql2/promise` with sensible defaults, transaction support, structured error handling, and metrics collection.

## Features

- **Connection Pooling**: Sensible defaults (keep-alive, timeouts, queue-don't-drop)
- **Parameterized Queries**: No string interpolation; safe from SQL injection
- **Stored Procedures**: Properly parameterized procedure calls with multi-result-set support
- **Transactions**: ACID-compliant with automatic rollback on errors
- **Graceful Shutdown**: Drain pools and close connections cleanly
- **Pool Metrics**: Exportable to Prometheus, Datadog, or custom monitoring
- **Structured Error Handling**: `MySQLError` is throwable and `instanceof Error`
- **Query Timeouts**: Per-query and connector-wide defaults
- **Multi-Database Support**: Manage multiple named connectors via `MySQLConnections`
- **Health Checks**: Built-in `ping()` for liveness probes
- **SSL/TLS Support**: Secure connections with certificate loading

## Installation

```bash
npm install @quicore/mysql mysql2@^3.22.0
```

> **Note:** `@quicore/mysql` requires `mysql2` ≥ 3.22.0 for features like `idleTimeout` and `enableKeepAlive`.

## Quick Start

### Single Database Connection

```javascript
import { MySQLConnector } from '@quicore/mysql';

const connector = new MySQLConnector('primary', {
  host: 'localhost',
  user: 'root',
  password: 'secret',
  database: 'myapp',
});

// Simple query
const result = await connector.query(
  'SELECT id, email, name FROM users WHERE id = ?',
  [42]
);
console.log(result.first()); // { id: 42, email: '...', name: '...' }

// Get row count
console.log(result.count()); // 1

// All results
console.log(result.results); // [{ id: 42, ... }]
```

### Multiple Database Connections

```javascript
import { MySQLConnections } from '@quicore/mysql';

const db = new MySQLConnections([
  {
    id: 'primary',
    host: 'primary.example.com',
    user: 'app',
    password: 'secret',
    database: 'myapp',
    connectionLimit: 20,
  },
  {
    id: 'replica',
    host: 'replica.example.com',
    user: 'app',
    password: 'secret',
    database: 'myapp',
    connectionLimit: 10,
  },
]);

// Query against a named connection
const users = await db.query('primary', 'SELECT * FROM users LIMIT 10');

// Stored procedure on replica
const stats = await db.sproc('replica', 'get_dashboard_stats', [userId]);

// Health check all connections
const health = await db.pingAll(5000);
console.log(health); // { primary: true, replica: true }

// Graceful shutdown
await db.closeAll();
```

## API Documentation

### MySQLConnector

The core class for a single database connection pool.

#### Constructor

```javascript
new MySQLConnector(id, config, options)
```

**Parameters:**
- `id` (string, required): Unique identifier for this connector (used in logs, metrics)
- `config` (object): mysql2 pool configuration
  - `host` (string): Database server hostname
  - `port` (number): Database port (default: 3306)
  - `user` (string): Database username
  - `password` (string): Database password
  - `database` (string): Database name
  - `connectionLimit` (number): Max connections in pool (default: 10)
  - `ssl` (object|boolean): SSL/TLS configuration
- `options` (object):
  - `logger` (object): Logger with `.log({ message, level, ...extras })` method
  - `defaultQueryTimeoutMs` (number): Default timeout for all queries (default: 30000)

**Default Pool Options:**
```javascript
{
  connectionLimit: 10,
  waitForConnections: true,      // Queue requests instead of rejecting
  queueLimit: 0,                 // Unbounded queue
  enableKeepAlive: true,         // Survive NAT idle reaping
  keepAliveInitialDelay: 10000,  // Start after 10s idle
  connectTimeout: 10000,         // Connection establishment timeout
  idleTimeout: 60000,            // Release idle connections after 60s
  dateStrings: true,             // Avoid timezone footguns
  namedPlaceholders: true,       // Support :name in addition to ?
}
```

#### Methods

**query(sqlOrOptions, params?, opts?)**

Execute a parameterized SQL query.

```javascript
// Simple query with positional parameters
const result = await connector.query(
  'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL',
  ['user@example.com']
);

// Named parameters
const result = await connector.query(
  'SELECT * FROM users WHERE email = :email AND status = :status',
  { email: 'user@example.com', status: 'active' }
);

// Query options (nestTables, timeout)
const result = await connector.query(
  { sql: 'SELECT u.id, o.id FROM users u JOIN orders o ON u.id = o.user_id', nestTables: true },
  [],
  { timeoutMs: 5000 }
);

// Log the rendered SQL for debugging
const result = await connector.query(
  'SELECT * FROM users WHERE id = ?',
  [42],
  { logSQL: true }
);
```

**sproc(sprocName, params?, opts?)**

Execute a stored procedure with parameterized arguments.

```javascript
// Stored procedure returning a single result set
const result = await connector.sproc('get_user_profile', [userId]);
console.log(result.first()); // First row of result

// Stored procedure with multiple result sets
const result = await connector.sproc('get_dashboard_data', [userId]);
const [users, orders, stats] = result.resultSets; // All result sets

// With options
const result = await connector.sproc('complex_query', [param1, param2], {
  nestTables: true,
});
```

**transaction(callback)**

Execute a callback inside a database transaction. Commits on success, rolls back on error.

```javascript
await connector.transaction(async (tx) => {
  // Both queries are on the same connection, within a transaction
  const userResult = await tx.query(
    'INSERT INTO users (email, name) VALUES (?, ?)',
    ['new@example.com', 'New User']
  );
  
  const userId = userResult.results.insertId;
  
  await tx.query(
    'INSERT INTO user_profiles (user_id, bio) VALUES (?, ?)',
    [userId, 'Welcome!']
  );
  
  // If anything throws, both INSERTs roll back automatically
});
```

**ping(timeoutMs?)**

Quick health check. Returns `true` if `SELECT 1` succeeds.

```javascript
const isHealthy = await connector.ping(5000);
if (isHealthy) {
  console.log('Database is reachable');
}
```

**getMetrics()**

Collect pool statistics for monitoring/observability.

```javascript
const metrics = connector.getMetrics();
console.log(metrics);
// {
//   connectorId: 'primary',
//   initialized: true,
//   closed: false,
//   totalConnections: 8,
//   freeConnections: 5,
//   queuedRequests: 0,
//   connectionLimit: 20,
// }
```

**close()**

Gracefully close the pool. Safe to call multiple times (idempotent).

```javascript
await connector.close();
// After this, the connector cannot be reused
```

**setLogger(logger)**

Set or replace the logger.

```javascript
connector.setLogger({
  log: ({ message, level, connectorId, ...extras }) => {
    console.log(`[${level}] ${connectorId}: ${message}`, extras);
  },
});
```

### MySQLConnections

Manages multiple named `MySQLConnector` instances for services that need multiple databases.

#### Constructor

```javascript
new MySQLConnections(configs, options)
```

**Parameters:**
- `configs` (Array): Array of connector configs, each with an `id` field
- `options` (object):
  - `logger` (object): Applied to all connectors
  - `defaultQueryTimeoutMs` (number): Applied to all connectors

#### Methods

**get(key)**

Retrieve a connector by key.

```javascript
const primaryConnector = db.get('primary');
const customMetrics = primaryConnector.getMetrics();
```

**query(key, sqlOrOptions, params?, opts?)**

Execute a query on a named connector.

```javascript
const result = await db.query(
  'primary',
  'SELECT * FROM users WHERE active = ?',
  [true]
);
```

**sproc(key, sprocName, params?, opts?)**

Execute a stored procedure on a named connector.

```javascript
const result = await db.sproc('replica', 'get_monthly_stats', [2024, 5]);
```

**transaction(key, callback)**

Run a callback in a transaction on a named connector.

```javascript
await db.transaction('primary', async (tx) => {
  await tx.query('UPDATE users SET balance = balance + ? WHERE id = ?', [100, userId]);
  await tx.query('INSERT INTO audit_log (user_id, action) VALUES (?, ?)', [userId, 'credit']);
});
```

**pingAll(timeoutMs?)**

Health-check all configured connectors.

```javascript
const health = await db.pingAll(5000);
// { primary: true, replica: false, reports: true }
```

**getMetrics()**

Collect metrics from all connectors.

```javascript
const allMetrics = db.getMetrics();
allMetrics.forEach(m => {
  console.log(`${m.connectorId}: ${m.freeConnections}/${m.connectionLimit} connections available`);
});
```

**closeAll()**

Gracefully close all pools.

```javascript
await db.closeAll();
```

### MySQLResults

Represents a successful query result.

#### Properties

- `results`: Raw results array or row object
- `fields`: Column metadata from mysql2
- `count()`: Number of rows returned
- `first()`: First row or null
- `supportId`: Unique identifier for debugging (UUID)
- `timestamp`: When the query completed (Date)
- `sql`: Rendered SQL string (for display)
- `params`: Query parameters
- `durationMs`: Query execution time in milliseconds
- `hasError`: Always `false` for successful queries

#### Example

```javascript
const result = await connector.query('SELECT * FROM users LIMIT 100');

console.log(result.count());      // 100
console.log(result.first());      // { id: 1, email: '...', ... }
console.log(result.results);      // [{ id: 1, ... }, { id: 2, ... }, ...]
console.log(result.durationMs);  // 45.23
console.log(result.supportId);   // e.g. "a1b2c3d4-..."
```

### MySQLError

Structured error for all MySQL failures. Extends `Error` and is throwable.

#### Properties

- `message`: Human-readable error message
- `name`: "MySQLError"
- `hasError`: Always `true`
- `supportId`: Unique identifier for debugging
- `timestamp`: When the error occurred
- `sql`: Rendered SQL query (if available)
- `params`: Query parameters (if available)
- `durationMs`: How long the query ran before failing
- `error`: Original error object with code, errno, sqlState, etc.
- `cause`: Original error (Node 16.9+)

#### Example

```javascript
try {
  await connector.query('SELECT * FROM nonexistent_table');
} catch (err) {
  console.log(err instanceof Error);  // true
  console.log(err.message);           // "Table 'mydb.nonexistent_table' doesn't exist"
  console.log(err.supportId);         // "a1b2c3d4-..." for customer support
  console.log(err.sql);               // "SELECT * FROM nonexistent_table"
  console.log(err.error.code);        // "ER_NO_SUCH_TABLE"
}
```

## Configuration

### Pool Sizing

Choose `connectionLimit` based on your workload:

```
connectionLimit = (core_count * 2) + spare_connections
```

**Examples:**
- **High-concurrency HTTP API** (4 cores): `8 + 2 = 10`
- **Medium concurrency** (2 cores): `4 + 2 = 6`
- **Read replicas** (high load, light queries): `20–40`
- **Reporting/batch** (low concurrency): `2–4`

In practice, monitor actual pool utilization via `getMetrics()` and adjust.

### SSL/TLS Configuration

```javascript
// With PEM files on disk
const connector = new MySQLConnector('primary', {
  host: 'db.example.com',
  user: 'app',
  password: 'secret',
  database: 'myapp',
  ssl: {
    ca: '/path/to/ca.pem',
    cert: '/path/to/client-cert.pem',
    key: '/path/to/client-key.pem',
    rejectUnauthorized: true,
  },
});

// With PEM strings in memory
const connector = new MySQLConnector('primary', {
  host: 'db.example.com',
  user: 'app',
  password: 'secret',
  database: 'myapp',
  ssl: {
    ca: '-----BEGIN CERTIFICATE-----\n...',
    cert: '-----BEGIN CERTIFICATE-----\n...',
    key: '-----BEGIN PRIVATE KEY-----\n...',
  },
});

// Simple SSL (verify server cert but not client)
const connector = new MySQLConnector('primary', {
  host: 'db.example.com',
  user: 'app',
  password: 'secret',
  database: 'myapp',
  ssl: true,  // Uses system CA bundle
});
```

### Named Placeholders

Use `:name` syntax for cleaner queries:

```javascript
const result = await connector.query(
  'SELECT * FROM users WHERE email = :email AND role = :role',
  { email: 'user@example.com', role: 'admin' }
);
```

### Query Timeouts

Set timeout per-query or use connector default:

```javascript
// Use connector's defaultQueryTimeoutMs (30s by default)
const result = await connector.query('SELECT SLEEP(5)');

// Override for a specific query
const result = await connector.query(
  'SELECT * FROM huge_table',
  [],
  { timeoutMs: 60000 }  // 60 seconds
);

// Timeout errors are thrown as MySQLError
try {
  await connector.query('SELECT SLEEP(100)', [], { timeoutMs: 5000 });
} catch (err) {
  console.log(err.error.timeout);  // true
}
```

## Error Handling

All errors are thrown as `MySQLError`, which is a proper `Error` subclass:

```javascript
import { MySQLError } from '@quicore/mysql';

try {
  await connector.query('SELECT * FROM users WHERE email = ?', [email]);
} catch (err) {
  if (err instanceof MySQLError) {
    // Safe to use err.supportId for customer support lookup
    console.error(`Query failed [${err.supportId}]: ${err.message}`);
    
    if (err.error.timeout) {
      console.error('Query timed out');
    } else if (err.error.code === 'ER_DUP_ENTRY') {
      console.error('Duplicate key violation');
    } else if (err.error.fatal) {
      console.error('Fatal connection error; pool may need restart');
    }
    
    res.status(500).json({
      error: 'Database error',
      supportId: err.supportId,
    });
  } else {
    // Non-database error
    throw err;
  }
}
```

## Transactions

Transactions are fully isolated on a single connection and automatically roll back on errors:

```javascript
await connector.transaction(async (tx) => {
  // tx has .query() and .sproc() methods
  
  const user = await tx.query(
    'INSERT INTO users (email, name) VALUES (?, ?)',
    ['new@example.com', 'Alice']
  );
  const userId = user.results.insertId;
  
  // If this query fails, both INSERTs roll back
  await tx.query(
    'INSERT INTO user_preferences (user_id, language) VALUES (?, ?)',
    [userId, 'en']
  );
});
```

For distributed transactions across multiple connectors:

```javascript
try {
  // Manually manage transactions on separate connectors
  await db.get('primary').transaction(async (tx) => {
    await tx.query('UPDATE account SET balance = balance - ? WHERE id = ?', [amount, fromId]);
  });
  
  await db.get('audit').transaction(async (tx) => {
    await tx.query(
      'INSERT INTO transfers (from_id, to_id, amount) VALUES (?, ?, ?)',
      [fromId, toId, amount]
    );
  });
} catch (err) {
  // One failed; log the error and notify
  console.error(`Transfer failed [${err.supportId}]:`, err.message);
}
```

## Monitoring & Observability

### Health Checks

```javascript
// Express middleware
app.get('/health', async (req, res) => {
  try {
    const health = await db.pingAll(2000);
    const allHealthy = Object.values(health).every(h => h === true);
    res.status(allHealthy ? 200 : 503).json({ ready: allHealthy, databases: health });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});
```

### Metrics Export (Prometheus)

```javascript
import client from 'prom-client';

// Periodically update metrics
setInterval(() => {
  const metrics = db.getMetrics();
  metrics.forEach(m => {
    gauge_connections_free.set(
      { connector: m.connectorId },
      m.freeConnections
    );
    gauge_connections_total.set(
      { connector: m.connectorId },
      m.totalConnections
    );
  });
}, 10000);
```

### Query Logging

```javascript
const connector = new MySQLConnector('primary', config, {
  logger: {
    log: ({ message, level, connectorId, supportId, durationMs }) => {
      // Send to ELK, Datadog, etc.
      if (level === 'error') {
        console.error(`[${connectorId}] ${message} (${supportId})`);
      } else if (durationMs > 1000) {
        console.warn(`Slow query [${connectorId}]: ${durationMs.toFixed(2)}ms`);
      }
    },
  },
  defaultQueryTimeoutMs: 30000,
});
```

## Graceful Shutdown

Always close pools on SIGTERM/SIGINT to avoid resource leaks:

```javascript
import { MySQLConnections } from '@quicore/mysql';

const db = new MySQLConnections([...]);
const server = app.listen(3000);

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down gracefully...`);
  
  // Stop accepting new requests
  server.close();
  
  // Drain existing connections and close pool
  await db.closeAll();
  
  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## Security Best Practices

1. **Always use parameterized queries** — never concatenate user input:
   ```javascript
   // ❌ DON'T
   const result = await connector.query(`SELECT * FROM users WHERE id = ${userId}`);
   
   // ✅ DO
   const result = await connector.query('SELECT * FROM users WHERE id = ?', [userId]);
   ```

2. **Use environment variables** for secrets:
   ```javascript
   const config = {
     host: process.env.DB_HOST,
     user: process.env.DB_USER,
     password: process.env.DB_PASSWORD,
     database: process.env.DB_NAME,
   };
   ```

3. **Enable SSL/TLS** for remote databases.

4. **Use restrictive database permissions**:
   ```sql
   -- Create a read-only user for reporting
   CREATE USER 'reporter'@'%' IDENTIFIED BY 'password';
   GRANT SELECT ON mydb.* TO 'reporter'@'%';
   
   -- Create an app user with full permissions
   CREATE USER 'app'@'%' IDENTIFIED BY 'password';
   GRANT ALL ON mydb.* TO 'app'@'%';
   ```

5. **Validate and sanitize** application-level input (even with parameterized queries).

6. **Monitor error logs** for suspicious patterns (e.g., repeated connection failures).

## Examples

### Express.js Integration

```javascript
import express from 'express';
import { MySQLConnections, MySQLError } from '@quicore/mysql';

const db = new MySQLConnections([
  {
    id: 'primary',
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 20,
  },
]);

const app = express();
app.use(express.json());

// Middleware for error handling
app.use((err, req, res, next) => {
  if (err instanceof MySQLError) {
    console.error(`Query failed [${err.supportId}]:`, err.message);
    return res.status(500).json({
      error: 'Database error',
      supportId: err.supportId,
    });
  }
  next(err);
});

// GET /users
app.get('/users', async (req, res, next) => {
  try {
    const result = await db.query('primary', 'SELECT id, email, name FROM users LIMIT 100');
    res.json({ count: result.count(), users: result.results });
  } catch (err) {
    next(err);
  }
});

// GET /users/:id
app.get('/users/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'primary',
      'SELECT * FROM users WHERE id = ?',
      [req.params.id]
    );
    const user = result.first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// POST /users
app.post('/users', async (req, res, next) => {
  try {
    const { email, name } = req.body;
    const result = await db.query(
      'primary',
      'INSERT INTO users (email, name) VALUES (?, ?)',
      [email, name]
    );
    res.status(201).json({ id: result.results.insertId });
  } catch (err) {
    next(err);
  }
});

// POST /transfer (transactional)
app.post('/transfer', async (req, res, next) => {
  try {
    const { fromUserId, toUserId, amountCents } = req.body;
    
    await db.transaction('primary', async (tx) => {
      await tx.query(
        'UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?',
        [amountCents, fromUserId]
      );
      await tx.query(
        'UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?',
        [amountCents, toUserId]
      );
    });
    
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /health
app.get('/health', async (req, res) => {
  try {
    const health = await db.pingAll(2000);
    const ready = Object.values(health).every(h => h === true);
    res.status(ready ? 200 : 503).json({ ready, databases: health });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

// GET /metrics
app.get('/metrics', (req, res) => {
  const metrics = db.getMetrics();
  res.json(metrics);
});

// Graceful shutdown
const server = app.listen(3000, () => {
  console.log('Server listening on port 3000');
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received; shutting down gracefully');
  server.close();
  await db.closeAll();
  console.log('Shutdown complete');
  process.exit(0);
});
```

### Batch Insert

```javascript
async function insertUsers(users) {
  const connector = new MySQLConnector('primary', config);
  
  // For large batches, use transactions to improve throughput
  await connector.transaction(async (tx) => {
    for (const user of users) {
      await tx.query(
        'INSERT INTO users (email, name, created_at) VALUES (?, ?, NOW())',
        [user.email, user.name]
      );
    }
  });
}

// Or use a single multi-row INSERT
async function insertUsersOptimized(users) {
  const connector = new MySQLConnector('primary', config);
  
  const placeholders = users.map(() => '(?, ?, NOW())').join(', ');
  const params = users.flatMap(u => [u.email, u.name]);
  
  const result = await connector.query(
    `INSERT INTO users (email, name, created_at) VALUES ${placeholders}`,
    params
  );
  
  console.log(`Inserted ${result.results.affectedRows} rows`);
}
```

### Migration & Schema Management

```javascript
import fs from 'fs';
import path from 'path';

async function runMigrations() {
  const connector = new MySQLConnector('primary', config);
  
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();
  
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await connector.query(sql);
      console.log(`✓ ${file}`);
    } catch (err) {
      console.error(`✗ ${file}: ${err.message}`);
      throw err;
    }
  }
  
  await connector.close();
}

runMigrations().catch(console.error);
```

## License

MIT

## Library usage in your services

```js
import { MySQLConnections, MySQLError } from 'mysql-connector';

const db = new MySQLConnections([
  {
    id: 'primary',
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'app',
    connectionLimit: 8,
  },
]);

// Simple query
const result = await db.query('primary', 'SELECT * FROM users WHERE id = ?', [42]);
console.log(result.first());

// Transaction
await db.transaction('primary', async (tx) => {
  await tx.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
  await tx.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
});

// Stored procedure
const summary = await db.sproc('primary', 'get_user_summary', [42]);

// Error handling
try {
  await db.query('primary', 'SELECT * FROM missing');
} catch (err) {
  if (err instanceof MySQLError) {
    console.error(err.supportId, err.error.code);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await db.closeAll();
  process.exit(0);
});
```

## Pool sizing

For your quota-constrained setup, the formula is:

```
pool_size_per_process × processes_per_VM × num_VMs × num_tools_sharing_account ≤ 0.75 × quota
```

The 0.75 leaves headroom for deploys, failover, and admin sessions. Start small (`connectionLimit: 8`), measure with `/metrics`, raise only if `queuedRequests` is consistently > 0 during peak.

## Key differences vs. the original package

| Issue in original | Fixed how |
|---|---|
| `prepareQuery` did unsafe string interpolation, then real execution used parameters — logs didn't match reality | `mysql2.format()` for diagnostic rendering only; execution is always parameterized |
| `connectionLimit: 10` hardcoded *after* `...this.config`, overriding caller config | Defaults spread first, caller config wins |
| No transaction support — `pool.query()` calls landed on different physical connections | `transaction(cb)` acquires a dedicated connection, commits/rollbacks, releases |
| `sproc()` did string-interpolated params (injection risk) | Uses `CALL sp(?, ?, ?)` with parameter binding |
| `setError` had three `if (error.code)` branches (copy-paste bug) | Each property checked against itself; adds `errno`, `sqlState` |
| `MySQLError extends MySQLResponse` — wasn't `instanceof Error`, broke middleware | `MySQLError extends Error`; carries response metadata as fields |
| Errors sometimes thrown, sometimes returned | Always thrown — single, idiomatic contract |
| Missing `enableKeepAlive`, `connectTimeout`, `idleTimeout` | All present with production-grade defaults |
| No `close()` / graceful shutdown | `close()` on connector, `closeAll()` on manager |
| No pool metrics | `getMetrics()` exposes total/free/queued connections |
| No per-query timeout | `defaultQueryTimeoutMs` + per-call override |
| Connection identification | Sets `connectAttributes.program_name` so you can see who's holding what in `SHOW PROCESSLIST` |

## Bigger picture

This package centralizes the *code* for connecting to MySQL — it doesn't centralize the *connections* themselves. Every service still opens its own pool against the DB. If quota pressure remains an issue after right-sizing, put **ProxySQL** or **RDS Proxy** between your services and MySQL — that's what actually multiplexes thousands of app-side connections onto a small DB-side pool. Your code wouldn't change; you just point at the proxy's host/port.
