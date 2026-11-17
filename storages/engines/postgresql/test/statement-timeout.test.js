/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const helpers = require('../../../test/helpers');
const { DatabasePG, runMaintenance, setRequestServingForTests } = require('../src/DatabasePG.ts');

// Time limits on the pools of a request-serving process: a statement over
// `statementTimeoutMs` is cancelled (57014), a transaction idle over
// `idleInTransactionTimeoutMs` is terminated. Streamed reads are limited per
// batch, maintenance work runs on an unlimited pool, and a connection the
// server terminates never takes the process down. Every limit here is a few
// hundred ms with `pg_sleep`, never a real 30 s wait.
describe('[PGST] PostgreSQL time limits of request-serving pools', function () {
  this.timeout(20000);
  const opened = [];

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    const { _internals } = require('../src/_internals.ts');
    if (!_internals.getLogger) _internals.set('getLogger', helpers.getLogger);
  });

  afterEach(() => setRequestServingForTests(null));

  after(async () => {
    setRequestServingForTests(null);
    for (const db of opened) await db.close().catch(() => {});
  });

  /** A DatabasePG built as in a request-serving process (or not). */
  async function open (limits, { requestServing = true, max } = {}) {
    setRequestServingForTests(requestServing);
    const db = new DatabasePG({ ...helpers.state.config, ...limits, ...(max != null ? { max } : {}) });
    setRequestServingForTests(null);
    opened.push(db);
    await db.waitForConnection();
    return db;
  }

  async function show (db, setting) {
    return (await db.query('SHOW ' + setting)).rows[0][setting];
  }

  async function settle (pool, deadlineMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (pool.waitingCount === 0 && pool.totalCount === pool.idleCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('[PGLM] which pools carry the limits', () => {
    it('[PGLM1] a request-serving pool carries both configured limits', async () => {
      const db = await open({ statementTimeoutMs: 1500, idleInTransactionTimeoutMs: 2500 });
      assert.strictEqual(await show(db, 'statement_timeout'), '1500ms');
      assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '2500ms');
    });

    it('[PGLM2] any other process (master, command-line tools) gets unlimited pools', async () => {
      const db = await open({ statementTimeoutMs: 1500, idleInTransactionTimeoutMs: 2500 }, { requestServing: false });
      assert.strictEqual(await show(db, 'statement_timeout'), '0');
      assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '0');
    });

    it('[PGLM5] the role is read from the process: an API worker is limited, a process without a role is not', async () => {
      const saved = process.env.PRYV_WORKER_TYPE;
      try {
        process.env.PRYV_WORKER_TYPE = 'api';
        const worker = new DatabasePG({ ...helpers.state.config, statementTimeoutMs: 1500 });
        delete process.env.PRYV_WORKER_TYPE;
        const tool = new DatabasePG({ ...helpers.state.config, statementTimeoutMs: 1500 });
        opened.push(worker, tool);
        await worker.waitForConnection();
        await tool.waitForConnection();
        assert.strictEqual(await show(worker, 'statement_timeout'), '1500ms');
        assert.strictEqual(await show(tool, 'statement_timeout'), '0');
      } finally {
        if (saved == null) delete process.env.PRYV_WORKER_TYPE; else process.env.PRYV_WORKER_TYPE = saved;
      }
    });

    it('[PGLM3] 0 switches a limit off', async () => {
      const db = await open({ statementTimeoutMs: 0, idleInTransactionTimeoutMs: 2500 });
      assert.strictEqual(await show(db, 'statement_timeout'), '0');
      assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '2500ms');
    });

    it('[PGLM4] both audit pools are limited like the main one', async () => {
      const { _internals } = require('../src/_internals.ts');
      const { createAuditStorage } = require('../src/index.ts');
      const previous = _internals.config;
      _internals.set('config', { ...helpers.state.config, statementTimeoutMs: 1500, idleInTransactionTimeoutMs: 2500 });
      setRequestServingForTests(true);
      let audit;
      try {
        audit = createAuditStorage();
      } finally {
        setRequestServingForTests(null);
        _internals.set('config', previous);
      }
      opened.push(audit.db, audit.readDb);
      for (const db of [audit.db, audit.readDb]) {
        await db.waitForConnection();
        assert.strictEqual(await show(db, 'statement_timeout'), '1500ms');
        assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '2500ms');
      }
    });
  });

  describe('[PGSS] statements', () => {
    it('[PGSS1] a statement over the limit is cancelled (57014), with its text kept, and the pool serves the next one', async () => {
      const db = await open({ statementTimeoutMs: 300 });
      await assert.rejects(() => db.query('SELECT pg_sleep(2)'), (err) => {
        assert.strictEqual(err.code, '57014');
        assert.strictEqual(err.statementText, 'SELECT pg_sleep(2)');
        return true;
      });
      assert.strictEqual((await db.query('SELECT 1 AS one')).rows[0].one, 1);
    });

    it('[PGSS4] a statement of a transaction is cancelled with its text kept too', async () => {
      const db = await open({ statementTimeoutMs: 300 });
      await assert.rejects(() => db.withTransaction((client) => client.query('SELECT pg_sleep(2)')), (err) => {
        assert.strictEqual(err.code, '57014');
        assert.strictEqual(err.statementText, 'SELECT pg_sleep(2)');
        return true;
      });
      // the wrapper is gone once the client is back: no stacking across checkouts
      for (let i = 0; i < 5; i++) await db.withTransaction((client) => client.query('SELECT 1'));
      await settle(db.pool);
      for (const client of db.pool._clients) assert.ok(!Object.prototype.hasOwnProperty.call(client, 'query') || client.query === Object.getPrototypeOf(client).query);
    });

    it('[PGSS2] inside runMaintenance the same statement completes, on any DatabasePG', async () => {
      const db = await open({ statementTimeoutMs: 300, idleInTransactionTimeoutMs: 300 });
      await runMaintenance(async () => {
        await db.query('SELECT pg_sleep(0.6)');
        await db.withTransaction(async (client) => {
          await client.query('SELECT 1');
          await sleep(600);
          await client.query('SELECT pg_sleep(0.6)');
        });
        let n = 0;
        for await (const row of db.queryIterable('SELECT g, pg_sleep(0.4) FROM generate_series(1, 2) g', [], 2)) n += row.g;
        assert.strictEqual(n, 3);
      });
      await assert.rejects(() => db.query('SELECT pg_sleep(0.6)'), (err) => err.code === '57014');
    });

    it('[PGSS3] the schema set-up waits for its lock past the limit (unlimited pool)', async () => {
      const holder = await open({}, { requestServing: false });
      const lockClient = await holder.pool.connect();
      try {
        await lockClient.query('SELECT pg_advisory_lock($1)', [0x70727976]);
        setRequestServingForTests(true);
        const db = new DatabasePG({ ...helpers.state.config, statementTimeoutMs: 300 });
        setRequestServingForTests(null);
        opened.push(db);
        const connecting = db.ensureConnect();
        await sleep(800);
        await lockClient.query('SELECT pg_advisory_unlock($1)', [0x70727976]);
        await connecting;
        assert.strictEqual(db.connected, true);
      } finally {
        lockClient.release();
      }
    });
  });

  describe('[PGSI] streamed reads', () => {
    it('[PGSI1] the limit bounds each batch, not the stream: a slow reader gets every row', async () => {
      const db = await open({ statementTimeoutMs: 300 });
      let n = 0;
      for await (const row of db.queryIterable('SELECT g FROM generate_series(1, $1::int) g', [20], 4)) {
        n += 1;
        assert.strictEqual(row.g, n);
        if (n % 4 === 0) await sleep(350); // 5 batches: over 5 times the limit in total
      }
      assert.strictEqual(n, 20);
    });

    it('[PGSI2] a batch over the limit is cancelled and its transaction does not reach the next caller', async () => {
      const db = await open({ statementTimeoutMs: 300 }, { max: 1 });
      await assert.rejects(async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const row of db.queryIterable('SELECT g, pg_sleep(1) FROM generate_series(1, 2) g', [], 2)) { /* the first batch is cancelled */ }
      }, (err) => err.code === '57014' && /pg_sleep/.test(err.statementText));
      await settle(db.pool);
      // One connection only: a client handed back inside its aborted
      // transaction would fail this query (25P02).
      assert.strictEqual((await db.query('SELECT 1 AS one')).rows[0].one, 1);
    });

    it('[PGSI3] the stream settings do not outlive it', async () => {
      const db = await open({ statementTimeoutMs: 1500, idleInTransactionTimeoutMs: 2500 }, { max: 1 });
      // eslint-disable-next-line no-unused-vars
      for await (const row of db.queryIterable('SELECT g FROM generate_series(1, 3) g', [], 2)) { /* read all */ }
      assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '2500ms');
      assert.strictEqual(await show(db, 'cursor_tuple_fraction'), '0.1');
      // also after a consumer that stopped early
      // eslint-disable-next-line no-unreachable-loop
      for await (const row of db.queryIterable('SELECT g FROM generate_series(1, 3) g', [], 1)) { assert.ok(row); break; }
      assert.strictEqual(await show(db, 'idle_in_transaction_session_timeout'), '2500ms');
    });

    it('[PGSI4] a reader slower than the idle-in-transaction limit between batches is not cut', async () => {
      const db = await open({ idleInTransactionTimeoutMs: 300 });
      let n = 0;
      for await (const row of db.queryIterable('SELECT g FROM generate_series(1, 6) g', [], 2)) {
        n += row.g;
        await sleep(400);
      }
      assert.strictEqual(n, 21);
    });
  });

  describe('[PGSX] transactions left idle', () => {
    it('[PGSX1] a terminated transaction rejects with its own cause, the process lives on, the pool recovers', async () => {
      const db = await open({ idleInTransactionTimeoutMs: 300 });
      await assert.rejects(() => db.withTransaction(async (client) => {
        await client.query('SELECT 1');
        await sleep(800); // the server terminates the connection meanwhile
        await client.query('SELECT 2');
      }), (err) => !/ROLLBACK/i.test(err.message));
      // An unhandled 'error' on the checked-out client would have failed this
      // test as an uncaught exception by now.
      await sleep(100);
      await settle(db.pool);
      assert.strictEqual(db.pool.totalCount, db.pool.idleCount, 'the dead client is not kept checked out');
      assert.strictEqual((await db.query('SELECT 1 AS one')).rows[0].one, 1);
    });

    it('[PGSX2] a client held through getClient is discarded on release once its connection was terminated', async () => {
      const db = await open({ idleInTransactionTimeoutMs: 300 });
      const client = await db.getClient();
      await client.query('BEGIN');
      await sleep(800);
      await assert.rejects(() => client.query('SELECT 1'));
      client.release();
      await settle(db.pool);
      assert.strictEqual(db.pool.totalCount, db.pool.idleCount);
      assert.strictEqual((await db.query('SELECT 1 AS one')).rows[0].one, 1);
    });
  });
});
