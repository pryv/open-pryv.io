/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Turns the `refuse_unindexed_user` trigger of a table off and on for the
 * PostgreSQL benches, and makes sure it ends up enabled.
 *
 * Disabling a trigger is a table-wide change on the shared test database: a
 * bench killed while it is off would leave every later run unguarded until a
 * process boots (the boot enables a disabled guard again, with a warning).
 * So the first `set(false)` starts a detached watchdog process that polls the
 * bench's pid and, once the bench is gone however it ended (SIGKILL
 * included), enables the trigger again. `restore()` enables it, stops the
 * watchdog and returns the `tgenabled` state read back from the catalog.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TRIGGER = 'refuse_unindexed_user';

const WATCHDOG = `
const { Client } = require(process.env.BENCH_PG_MODULE);
const parent = Number(process.env.BENCH_PARENT_PID);
const sql = process.env.BENCH_ENABLE_SQL;
const timer = setInterval(async () => {
  try { process.kill(parent, 0); return; } catch (e) { if (e.code === 'EPERM') return; }
  clearInterval(timer);
  const c = new Client(JSON.parse(process.env.BENCH_PG_CONFIG));
  try { await c.connect(); await c.query(sql); } catch (e) { console.error(e.message); }
  await c.end().catch(() => {});
  process.exit(0);
}, 300);
`;

/**
 * @param {object} db the PostgreSQL database (storages.databasePG)
 * @param {string} [table]
 */
function guardTriggerToggle (db, table = 'events') {
  const enableSql = `ALTER TABLE ${table} ENABLE TRIGGER ${TRIGGER}`;
  let watchdog = null;

  function startWatchdog () {
    if (watchdog != null) return;
    const { host, port, database, user, password } = db.poolConfig;
    watchdog = spawn(process.execPath, ['-e', WATCHDOG], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        BENCH_PG_MODULE: require.resolve('pg'),
        BENCH_PARENT_PID: String(process.pid),
        BENCH_ENABLE_SQL: enableSql,
        BENCH_PG_CONFIG: JSON.stringify({ host, port, database, user, password })
      }
    });
    watchdog.unref();
  }

  async function set (on) {
    if (!on) startWatchdog();
    await db.query(on ? enableSql : `ALTER TABLE ${table} DISABLE TRIGGER ${TRIGGER}`);
  }

  async function state () {
    const res = await db.query('SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass', [TRIGGER, table]);
    return res.rows[0]?.tgenabled ?? null;
  }

  async function restore () {
    await db.query(enableSql);
    if (watchdog != null) { watchdog.kill(); watchdog = null; }
    return await state();
  }

  return { set, state, restore };
}

export { guardTriggerToggle };
