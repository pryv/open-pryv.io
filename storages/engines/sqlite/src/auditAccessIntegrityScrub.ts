/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The audit record of an access write names the access version by its key
 * only (the hash covers the token: a copy of it next to the access would be
 * an offline oracle for a weak token). Records written before carry the hash
 * in `content.record.integrity`: this walk removes it from every user's audit
 * database, then vacuums the databases it changed (the old values would stay
 * in free pages). A marker file in the users directory records that it
 * completed (a failed database is retried at the next start); `force` walks
 * again anyway (records a previous image wrote after a rollback). Event
 * records are left alone. Audit records carry no integrity of their own, so
 * the content is edited in place.
 *
 * Run by the storages barrel's start pass whenever the AUDIT engine is
 * SQLite, whatever the base engine (`storages/index.ts` `getTokensAtRest`).
 */

import fs from 'node:fs';
import path from 'node:path';
import SQLite3 from 'better-sqlite3';
import { execute, initWALAndConcurrentSafeWriteCapabilities } from './concurrentSafeWrite.ts';
import { _internals } from './_internals.ts';
import { SqliteStorage } from './userSQLite/Storage.ts';

const logger = _internals.lazyLogger('storage:audit-access-integrity');

type UsersDirectory = { init?: () => Promise<void>; getBasePath: () => string; listUserIds: () => Promise<string[]> };

/** Written in the users base directory once every audit database was scrubbed. */
const AUDIT_ACCESS_INTEGRITY_MARKER = 'audit-access-integrity-scrubbed.done';

const SCRUB_SQL = 'UPDATE events SET content = json_remove(content, \'$.record.integrity\') ' +
  'WHERE json_extract(content, \'$.record.key\') LIKE \'ACCESS:%\' AND json_extract(content, \'$.record.integrity\') IS NOT NULL';

type SqliteWritable = { prepare: (sql: string) => { run: () => { changes: number }; get: (...a: unknown[]) => unknown }; pragma: (s: string) => unknown; unsafeMode: (b: boolean) => unknown; close: () => void };

/** Scrub one audit database file; returns the records changed. */
async function scrubAuditFile (file: string): Promise<number> {
  const db = new SQLite3(file) as unknown as SqliteWritable;
  try {
    await initWALAndConcurrentSafeWriteCapabilities(db);
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'events\'').get() == null) return 0;
    let changes = 0;
    await execute(() => { changes = db.prepare(SCRUB_SQL).run().changes; });
    if (changes > 0) {
      try {
        db.prepare('VACUUM').run();
        db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
      } catch (err) {
        logger.warn('audit records of access writes: VACUUM of ' + file + ' skipped: ' + (err as Error).message);
      }
    }
    return changes;
  } finally {
    db.close();
  }
}

/**
 * Run the walk unless its marker is there (or with `force`). Returns null
 * when skipped (marker present, or no users directory in this process).
 */
async function scrubAccessAuditIntegrity (options: { force?: boolean } = {}): Promise<{ records: number; failedUsers: number } | null> {
  const users = _internals.userLocalDirectory as UsersDirectory | undefined;
  if (users == null) return null;
  let basePath: string;
  try {
    await users.init?.(); // idempotent; not initialised in the supervisor process
    basePath = users.getBasePath();
  } catch (_e) {
    return null;
  }
  const marker = path.join(basePath, AUDIT_ACCESS_INTEGRITY_MARKER);
  if (options.force !== true && fs.existsSync(marker)) return null;
  const audit = new SqliteStorage('audit'); // for the file path only, never initialised
  let records = 0;
  const failed: string[] = [];
  for (const userId of await users.listUserIds()) {
    const file = audit.existingPathForUser(userId);
    if (!fs.existsSync(file)) continue;
    try {
      records += await scrubAuditFile(file);
    } catch (err) {
      failed.push(userId);
      logger.error('audit records of access writes: scrub failed for user ' + userId + ': ' + (err as Error).message);
    }
  }
  if (records > 0) logger.info('audit records of access writes: the integrity copy removed from ' + records + ' records');
  if (failed.length === 0) {
    fs.writeFileSync(marker, 'DO NOT DELETE THIS FILE - IT RECORDS THAT THE AUDIT RECORDS OF ACCESS WRITES NO LONGER CARRY THE INTEGRITY HASH\n');
  }
  return { records, failedUsers: failed.length };
}

export { scrubAccessAuditIntegrity, scrubAuditFile, AUDIT_ACCESS_INTEGRITY_MARKER };
