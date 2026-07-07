import express from 'express';
import { MySQLConnections, MySQLError } from '../lib/index.js';

// ----------------------------------------------------------------------------
// Config — in production, read from secrets manager / env / Vault
// ----------------------------------------------------------------------------
const DB_CONFIGS = [
  {
    id: 'primary',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mysql_demo',
    // Service-tuned pool size; see formula in README.
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 8,
  },
];

const PORT = Number(process.env.PORT) || 3000;

// ----------------------------------------------------------------------------
// Bootstrap
// ----------------------------------------------------------------------------
const db = new MySQLConnections(DB_CONFIGS, {
  defaultQueryTimeoutMs: 10_000,
  logger: {
    log: ({ message, level = 'info', ...rest }) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...rest });
      (level === 'error' ? console.error : console.log)(line);
    },
  },
});

const app = express();
app.use(express.json());

// ----------------------------------------------------------------------------
// Routes — each demonstrates a different feature
// ----------------------------------------------------------------------------

// 1. Simple parameterized SELECT
app.get('/users', async (_req, res, next) => {
  try {
    const result = await db.query('primary', 'SELECT id, email, name, balance_cents FROM users');
    res.json({ count: result.count(), users: result.results, supportId: result.supportId });
  } catch (err) {
    next(err);
  }
});

// 2. Parameterized SELECT with a single-row helper
app.get('/users/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'primary',
      'SELECT id, email, name, balance_cents FROM users WHERE id = ?',
      [req.params.id]
    );
    const user = result.first();
    if (!user) return res.status(404).json({ error: 'User not found', supportId: result.supportId });
    res.json({ user, supportId: result.supportId, durationMs: result.durationMs });
  } catch (err) {
    next(err);
  }
});

// 3. INSERT with parameters — note no string concatenation anywhere
app.post('/users', async (req, res, next) => {
  try {
    const { email, name, balance_cents = 0 } = req.body || {};
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name are required' });
    }
    const result = await db.query(
      'primary',
      'INSERT INTO users (email, name, balance_cents) VALUES (?, ?, ?)',
      [email, name, balance_cents]
    );
    res.status(201).json({
      id: result.results.insertId,
      affectedRows: result.results.affectedRows,
      supportId: result.supportId,
    });
  } catch (err) {
    next(err);
  }
});

// 4. Stored procedure — properly parameterized, no string interpolation
app.get('/users/:id/summary', async (req, res, next) => {
  try {
    const result = await db.sproc('primary', 'get_user_summary', [req.params.id]);
    // The sproc returns two result sets; .resultSets has both.
    const [userRows, statsRows] = result.resultSets || [result.results, []];
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      user: userRows[0],
      stats: statsRows[0] || { order_count: 0, total_cents: 0 },
      supportId: result.supportId,
    });
  } catch (err) {
    next(err);
  }
});

// 5. Transaction — atomic transfer between two users
app.post('/transfer', async (req, res, next) => {
  try {
    const { fromUserId, toUserId, amountCents } = req.body || {};
    if (!fromUserId || !toUserId || !amountCents || amountCents <= 0) {
      return res.status(400).json({ error: 'fromUserId, toUserId, amountCents (positive) required' });
    }

    const txResult = await db.transaction('primary', async (tx) => {
      // Lock both rows in a deterministic order to avoid deadlocks.
      const [lowId, highId] = [fromUserId, toUserId].map(Number).sort((a, b) => a - b);
      await tx.query('SELECT id FROM users WHERE id IN (?, ?) FOR UPDATE', [lowId, highId]);

      const fromRow = await tx.query('SELECT balance_cents FROM users WHERE id = ?', [fromUserId]);
      const fromUser = fromRow.first();
      if (!fromUser) throw new Error(`User ${fromUserId} not found`);
      if (fromUser.balance_cents < amountCents) {
        throw new Error('Insufficient balance');
      }

      await tx.query(
        'UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?',
        [amountCents, fromUserId]
      );
      await tx.query(
        'UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?',
        [amountCents, toUserId]
      );
      return { transferred: amountCents };
    });

    res.json(txResult);
  } catch (err) {
    next(err);
  }
});

// 6. Demonstrate that string-looking-like-injection is safely parameterized
//   curl 'http://localhost:3000/users/search?name=Alice%27%20OR%201=1--'
//   Returns zero rows (correctly) — the apostrophe is escaped.
app.get('/users/search', async (req, res, next) => {
  try {
    const result = await db.query(
      'primary',
      'SELECT id, email, name FROM users WHERE name = ?',
      [req.query.name ?? '']
    );
    res.json({ count: result.count(), users: result.results });
  } catch (err) {
    next(err);
  }
});

// 7. Health check — uses ping() so it's cheap
app.get('/health', async (_req, res) => {
  const status = await db.pingAll(3000);
  const ok = Object.values(status).every(Boolean);
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', databases: status });
});

// 8. Pool metrics — point Prometheus at this
app.get('/metrics', (_req, res) => {
  res.json({ pools: db.getMetrics() });
});

// 9. Force an error to see the structured MySQLError shape
app.get('/error-demo', async (_req, res, next) => {
  try {
    await db.query('primary', 'SELECT * FROM nonexistent_table');
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// Error handler — converts MySQLError into a structured response
// ----------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof MySQLError) {
    return res.status(500).json({
      hasError: true,
      message: err.message,
      supportId: err.supportId,
      code: err.error?.code,
      // Don't leak SQL to clients in production — gated by NODE_ENV.
      ...(process.env.NODE_ENV !== 'production' && { sql: err.sql }),
    });
  }
  console.error({ level: 'error', message: err.message, stack: err.stack });
  res.status(500).json({ hasError: true, message: err.message });
});

// ----------------------------------------------------------------------------
// Startup + graceful shutdown
// ----------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', message: `Demo listening on :${PORT}` }));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', message: `Received ${signal}, shutting down` }));

  // 1. Stop accepting new HTTP requests.
  server.close(async () => {
    // 2. Drain in-flight queries and close pools.
    await db.closeAll();
    console.log(JSON.stringify({ level: 'info', message: 'Shutdown complete' }));
    process.exit(0);
  });

  // Hard timeout in case something hangs.
  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', message: 'Forced shutdown after 15s' }));
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
