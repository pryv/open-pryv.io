/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, getNewFixture, assert, cuid */

/**
 * [RCCR] CMC retry rows left under the id of an erased account
 * (usersRepository.reconcileCmcRetryOrphans, bin/reconcile-user-cores.js
 * --cmc-retries): listed by default, deleted with --apply only for an id that
 * holds nothing else and has no erasure record. PostgreSQL only.
 */

const RETRY_TYPE = 'cmc-internal/retry-cmc';
const RETRY_STREAM = ':_cmc:_internal:retries';

describe('[RCCR] CMC retry rows of erased accounts', function () {
  let usersRepository, erasures, connection;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    erasures = await require('business/src/auth/erasures.ts').getErasuresLocal();
    connection = usersRepository.storageLayer.connection;
  });

  function isPG () {
    return require('storages').databasePG != null;
  }

  async function addEvent (userId, type = RETRY_TYPE, streamId = RETRY_STREAM) {
    const id = cuid();
    const now = Date.now() / 1000;
    await connection.query(
      'INSERT INTO events (user_id, id, stream_ids, time, type, content, created, created_by, modified, modified_by) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $4, $7, $4, $7)',
      [userId, id, JSON.stringify([streamId]), now, type, JSON.stringify({ capabilityUrl: 'https://peer.example/invite?token=secret' }), 'system']);
    await connection.query('INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) VALUES ($1, $2, $3, $4)',
      [userId, id, streamId, streamId + '/']);
    // The integrity a server write would store (the suite checks every event's).
    const { integrity } = require('business');
    if (integrity.events.isActive) {
      const { rowToEvent } = require('storages/engines/postgresql/src/dataStore/localUserEventsPG.ts');
      const row = (await connection.query('SELECT * FROM events WHERE user_id = $1 AND id = $2', [userId, id])).rows[0];
      const event = rowToEvent(row);
      delete event.integrity;
      await connection.query('UPDATE events SET integrity = $3 WHERE user_id = $1 AND id = $2',
        [userId, id, integrity.events.compute(event).integrity]);
    }
    return id;
  }

  function assertHas (actual, expected, context) {
    assert.ok(actual != null, 'missing: ' + context);
    for (const [k, v] of Object.entries(expected)) assert.strictEqual(actual[k], v, k + ' in ' + JSON.stringify(actual));
  }

  async function countRows (userId) {
    const ev = await connection.query('SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1', [userId]);
    const links = await connection.query('SELECT COUNT(*)::int AS n FROM event_streams WHERE user_id = $1', [userId]);
    return { events: ev.rows[0].n, links: links.rows[0].n };
  }

  async function dropRows (userId) {
    await connection.query('DELETE FROM event_streams WHERE user_id = $1', [userId]);
    await connection.query('DELETE FROM events WHERE user_id = $1', [userId]);
  }

  function erasureRow (userId) {
    const now = Date.now();
    return { userId, username: 'rccrerasure', trigger: 'test', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
  }

  it('[RCCR1] lists the retry rows of an unindexed id, deletes them (and their stream links) only with apply, and nothing of an indexed account', async function () {
    if (!isPG()) {
      const s = await usersRepository.reconcileCmcRetryOrphans();
      assert.strictEqual(s.checked, false, 'not listed on this engine');
      return this.skip();
    }
    const kept = await getNewFixture().user('rccr' + cuid().slice(-8).toLowerCase());
    const keptId = kept.attrs.id;
    const orphanId = cuid();
    await addEvent(orphanId);
    await addEvent(orphanId);
    const keptEventId = await addEvent(keptId);
    try {
      const dry = await usersRepository.reconcileCmcRetryOrphans();
      assert.strictEqual(dry.checked, true);
      const listed = dry.orphans.find((o) => o.userId === orphanId);
      assertHas(listed, { events: 2, otherEvents: 0, accountStoreRows: 0, repairable: true }, JSON.stringify(dry.orphans));
      assert.ok(!dry.orphans.some((o) => o.userId === keptId), 'an indexed account is not listed');
      assert.deepStrictEqual(await countRows(orphanId), { events: 2, links: 2 }, 'a report deletes nothing');

      const applied = await usersRepository.reconcileCmcRetryOrphans({ apply: true });
      assert.strictEqual(applied.orphans.find((o) => o.userId === orphanId)?.deleted, 2);
      assert.deepStrictEqual(await countRows(orphanId), { events: 0, links: 0 }, 'rows and stream links deleted');
      const keptRetries = await connection.query('SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1 AND type = $2', [keptId, RETRY_TYPE]);
      assert.strictEqual(keptRetries.rows[0].n, 1, 'the indexed account keeps its retry row');

      const again = await usersRepository.reconcileCmcRetryOrphans({ apply: true });
      assert.ok(!again.orphans.some((o) => o.userId === orphanId), 'nothing left on a second run');
    } finally {
      await dropRows(orphanId);
      await connection.query('DELETE FROM event_streams WHERE user_id = $1 AND event_id = $2', [keptId, keptEventId]);
      await connection.query('DELETE FROM events WHERE user_id = $1 AND id = $2', [keptId, keptEventId]);
    }
  });

  it('[RCCR2] apply leaves an id that holds other events, account fields, or whose erasure is unfinished; the delete re-checks', async function () {
    if (!isPG()) return this.skip();
    const kept = await getNewFixture().user('rccs' + cuid().slice(-8).toLowerCase()); // not the empty-index refusal
    const keptId = kept.attrs.id;
    const accountStorage = usersRepository.userAccountStorage;
    const withData = cuid();
    const inErasure = cuid();
    const withAccount = cuid();
    await addEvent(withData);
    await addEvent(withData, 'note/txt', 'diary');
    await addEvent(inErasure);
    await erasures.insertIfAbsent(erasureRow(inErasure));
    await addEvent(withAccount);
    await accountStorage.setAccountField(withAccount, 'language', 'en', 'system', Date.now() / 1000);
    const keptEventId = await addEvent(keptId);
    try {
      const applied = await usersRepository.reconcileCmcRetryOrphans({ apply: true });
      assertHas(applied.orphans.find((o) => o.userId === withData), { repairable: false, reason: 'holds-data', otherEvents: 1 }, 'withData');
      assertHas(applied.orphans.find((o) => o.userId === inErasure), { repairable: false, reason: 'erasure-record' }, 'inErasure');
      assertHas(applied.orphans.find((o) => o.userId === withAccount), { repairable: false, reason: 'has-account-store', accountStoreRows: 1 }, 'withAccount');
      assert.deepStrictEqual(await countRows(withData), { events: 2, links: 2 });
      assert.deepStrictEqual(await countRows(inErasure), { events: 1, links: 1 });
      assert.deepStrictEqual(await countRows(withAccount), { events: 1, links: 1 });

      // The delete itself re-checks the erasure record, the account store and the index: direct calls delete nothing.
      const deleteRows = usersRepository.storageLayer.deleteEventTypeOrphanRows;
      assert.strictEqual(await deleteRows(RETRY_TYPE, inErasure), 0);
      assert.strictEqual(await deleteRows(RETRY_TYPE, withAccount), 0);
      assert.strictEqual(await deleteRows(RETRY_TYPE, keptId), 0, 'an indexed account');
      assert.deepStrictEqual(await countRows(inErasure), { events: 1, links: 1 });
      assert.deepStrictEqual(await countRows(withAccount), { events: 1, links: 1 });
      const keptRetries = await connection.query('SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1 AND id = $2', [keptId, keptEventId]);
      assert.strictEqual(keptRetries.rows[0].n, 1);
    } finally {
      await erasures.delete(inErasure).catch(() => {});
      await accountStorage._clearAll(withAccount).catch(() => {});
      await dropRows(withData);
      await dropRows(inErasure);
      await dropRows(withAccount);
      await connection.query('DELETE FROM event_streams WHERE user_id = $1 AND event_id = $2', [keptId, keptEventId]);
      await connection.query('DELETE FROM events WHERE user_id = $1 AND id = $2', [keptId, keptEventId]);
    }
  });

  it('[RCCR3] an empty users index facing such rows is refused, nothing deleted', async function () {
    if (!isPG()) return this.skip();
    const orphanId = cuid();
    await addEvent(orphanId);
    const original = usersRepository.usersIndex.getAllByUsername;
    usersRepository.usersIndex.getAllByUsername = async () => ({});
    try {
      const s = await usersRepository.reconcileCmcRetryOrphans({ apply: true });
      assert.strictEqual(s.refusedEmptyLocal, true);
      assert.ok(s.orphans.every((o) => o.repairable === false && o.deleted == null));
      assert.deepStrictEqual(await countRows(orphanId), { events: 1, links: 1 });
    } finally {
      usersRepository.usersIndex.getAllByUsername = original;
      await dropRows(orphanId);
    }
  });

  it('[RCCR4] bin/reconcile-user-cores.js --cmc-retries: a separate pass, reports by default, deletes with --apply', async function () {
    this.timeout(120000);
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const { childStorageEngineEnv } = require('test-helpers');
    const repoRoot = path.resolve(path.dirname(require('node:url').fileURLToPath(import.meta.url)), '../../../');
    const cli = (args) => spawnSync('node', [path.join(repoRoot, 'bin/reconcile-user-cores.js'), ...args],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...childStorageEngineEnv() }, timeout: 90000 });
    for (const [args, message] of [
      [['--cmc-retries', '--registrations'], /separate pass/],
      [['--cmc-retries', '--user-id', 'someid'], /belong to other passes/],
      [['--cmc-retries', '--apply', '--dry-run'], /contradict/]
    ]) {
      const run = cli(args);
      assert.strictEqual(run.status, 1, args.join(' ') + ': ' + run.stdout + run.stderr);
      assert.match(run.stderr, message, args.join(' '));
    }
    if (!isPG()) {
      const run = cli(['--cmc-retries']);
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /not listed on this engine/);
      return;
    }
    await getNewFixture().user('rcct' + cuid().slice(-8).toLowerCase());
    const orphanId = cuid();
    await addEvent(orphanId);
    try {
      const dry = cli(['--cmc-retries']);
      assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
      assert.match(dry.stdout, /--cmc-retries: DRY-RUN \(no writes\)/);
      assert.ok(dry.stdout.includes(orphanId + ': 1 retry rows, 0 other events: deleted with --apply'), dry.stdout);
      assert.deepStrictEqual(await countRows(orphanId), { events: 1, links: 1 });

      const applied = cli(['--cmc-retries', '--apply']);
      assert.strictEqual(applied.status, 0, applied.stdout + applied.stderr);
      assert.ok(applied.stdout.includes(orphanId + ': 1 retry rows, 0 other events: 1 deleted'), applied.stdout);
      assert.deepStrictEqual(await countRows(orphanId), { events: 0, links: 0 });
    } finally {
      await dropRows(orphanId);
    }
  });
});
