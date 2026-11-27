/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Session advisory locks taken by polling, for the runs that must not overlap
 * across processes (the migration runner, the time sort index build). The
 * caller holds them on a connection of its own (`DatabasePG.connectDedicated`)
 * and ends it afterwards, which releases the lock whatever happened.
 *
 * Polled with `pg_try_advisory_lock`, never waited on with
 * `pg_advisory_lock`: a statement waiting for the lock holds a snapshot, and
 * the holder may be building an index CONCURRENTLY, which waits for every
 * older snapshot. That wait goes through the holder's lock session, which
 * waits for nothing, so PostgreSQL sees no cycle: both would wait for ever.
 */

type LockRow = Record<string, unknown>;
interface AdvisoryLockClient { query: (sql: string, params?: unknown[]) => Promise<{ rows: LockRow[] }> }
interface AdvisoryLockLog { info?: (msg: string) => void; warn?: (msg: string) => void }

interface AcquireOptions {
  /** Log prefix, e.g. `[migrations] postgresql`. */
  label: string;
  /** What the holder is doing, e.g. `applying migrations`. */
  holderDoing: string;
  /** Delay between two tries. */
  pollMs?: number;
  /** Delay between two "still waiting" lines. */
  waitLogEveryMs?: number;
}

const LOCK_POLL_MS = 500;
const WAIT_LOG_EVERY_MS = 60_000;

// The granted session lock of key $1 in this database (a single bigint key:
// classid holds the high 32 bits, objid the low ones, objsubid is 1).
const HOLDER_SQL = 'SELECT a.pid, a.application_name, host(a.client_addr) AS client_addr ' +
  'FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid ' +
  "WHERE l.locktype = 'advisory' AND l.granted " +
  'AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) ' +
  'AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint AND l.objsubid = 1';

/** Who holds the lock `key`, for a log line; never throws. */
async function describeHolder (client: AdvisoryLockClient, key: number): Promise<string> {
  try {
    const res = await client.query(HOLDER_SQL, [key]);
    const h = res.rows[0];
    if (h == null) return 'a session not visible to this role';
    const from = h.client_addr != null ? 'from ' + String(h.client_addr) : 'over a local socket';
    const app = typeof h.application_name === 'string' && h.application_name !== '' ? ` (${h.application_name})` : '';
    return `pid ${String(h.pid)} ${from}${app}`;
  } catch (err) {
    return 'an unknown session';
  }
}

function formatElapsed (ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Take the session advisory lock `key` on `client`, polling. Logs when it has
 * to wait (with the holder), again every `waitLogEveryMs` with the time
 * waited, and once the lock is obtained after a wait. No maximum wait: a run
 * must not start before the other one ends, and a dead holder's connection
 * closes, which releases the lock.
 */
async function acquireAdvisoryLock (client: AdvisoryLockClient, key: number, log: AdvisoryLockLog, opts: AcquireOptions): Promise<void> {
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const waitLogEveryMs = opts.waitLogEveryMs ?? WAIT_LOG_EVERY_MS;
  const t0 = Date.now();
  let waited = false;
  let nextLogAt = 0;
  for (;;) {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (res.rows[0]?.locked === true) {
      if (waited) log.info?.(`${opts.label}: lock obtained after ${formatElapsed(Date.now() - t0)}`);
      return;
    }
    if (Date.now() >= nextLogAt) {
      const holder = await describeHolder(client, key);
      log.info?.(waited
        ? `${opts.label}: still waiting for the lock (${formatElapsed(Date.now() - t0)}), held by ${holder}`
        : `${opts.label}: another process is ${opts.holderDoing}; waiting for it (lock held by ${holder})`);
      waited = true;
      nextLogAt = Date.now() + waitLogEveryMs;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Release the lock `key` held on `client`. Returns false, with a warning,
 * when the session no longer held it (`pg_advisory_unlock` returned false,
 * e.g. behind a transaction-mode pooler) or the connection is gone: in both
 * cases another process may have run at the same time.
 */
async function releaseAdvisoryLock (client: AdvisoryLockClient, key: number, log: AdvisoryLockLog, label: string): Promise<boolean> {
  try {
    const res = await client.query('SELECT pg_advisory_unlock($1) AS unlocked', [key]);
    if (res.rows[0]?.unlocked === true) return true;
    log.warn?.(`${label}: the lock was not held any more at the end of the run; another process may have run at the same time`);
  } catch (err) {
    log.warn?.(`${label}: the lock connection was lost during the run (${(err as Error).message}); another process may have run at the same time`);
  }
  return false;
}

export { acquireAdvisoryLock, releaseAdvisoryLock, describeHolder };
export type { AdvisoryLockClient, AdvisoryLockLog };
