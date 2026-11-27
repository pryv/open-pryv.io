/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const { LRUCache: LRU } = require('lru-cache');
const { UserAuditDatabasePG } = require('./UserAuditDatabasePG.ts');
const { _internals } = require('./_internals.ts');
const { StreamIndexState, ensureAuditStreamIndex } = require('./auditStreamIndex.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

type DbLike = {
  ensureConnect: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  getClient?: () => Promise<unknown>;
  close: () => Promise<void>;
};
type StreamIndexStateLike = { complete: boolean; isComplete: () => boolean; refresh: () => Promise<boolean> };
type FillLog = { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
type UserAuditDbLike = { init: () => Promise<void>; close: () => void };
type UserDbsLRU = {
  get: (key: string) => UserAuditDbLike | undefined;
  set: (key: string, value: UserAuditDbLike) => void;
  delete: (key: string) => void;
  clear: () => void;
};

class AuditStoragePG {
  initialized: boolean = false;
  userDBsCache: UserDbsLRU;
  db: DbLike;
  /**
   * Pool for STREAMED reads only, which hold a connection for the whole
   * response. Separate from `db` so a slow reader can never queue an audit
   * write behind it. Falls back to `db` when a caller builds this storage with
   * one pool (tests, and any embedder that predates the split).
   */
  readDb: DbLike;
  logger: Logger;
  /** Whether the users index is in this database (base storage on PostgreSQL). */
  seesUsersIndex: boolean;
  /** Shared with the per-user handles, cached ones included. */
  guard: { on: boolean } = { on: false };
  /**
   * Whether `audit_event_streams` is complete (see auditStreamIndex.ts),
   * shared with the per-user handles: read at init, then again in the
   * background when older than STREAM_INDEX_RECHECK_MS, so a worker learns
   * within that delay that a fill ended or that the state was reset.
   */
  streamIndex: StreamIndexStateLike;

  constructor (db: DbLike, readDb?: DbLike, options: { seesUsersIndex?: boolean } = {}) {
    this.db = db;
    this.readDb = readDb ?? db;
    this.seesUsersIndex = options.seesUsersIndex === true;
    this.logger = _internals.getLogger('audit-storage-pg');
    this.streamIndex = new StreamIndexState(this.db);
    this.userDBsCache = new LRU({
      max: CACHE_SIZE,
      dispose: function (db: UserAuditDbLike) { db.close(); }
    });
  }

  async init (): Promise<this> {
    if (this.initialized) throw new Error('Database already initialized');
    this.initialized = true;
    await this.db.ensureConnect();
    if (this.readDb !== this.db) await this.readDb.ensureConnect();
    await this.streamIndex.refresh();
    this.logger.info('Audit storage (PG) initialized');
    return this;
  }

  /**
   * Fill `audit_event_streams` until complete (see auditStreamIndex.ts):
   * the start does it before serving. Idempotent; one query once complete.
   */
  async ensureStreamIndex (options: { logger?: FillLog; batchRows?: number } = {}): Promise<unknown> {
    this.checkInitialized();
    const res = await ensureAuditStreamIndex(this.db, options);
    await this.streamIndex.refresh();
    return res;
  }

  getVersion (): string {
    return VERSION;
  }

  checkInitialized (): void {
    if (!this.initialized) throw new Error('Initialize db component before using it');
  }

  async forUser (userId: string): Promise<UserAuditDbLike> {
    this.checkInitialized();
    let userDb = this.userDBsCache.get(userId);
    if (!userDb) {
      const fresh: UserAuditDbLike = new UserAuditDatabasePG(this.db, userId, this.logger, this.readDb, this.guard, this.streamIndex);
      await fresh.init();
      this.userDBsCache.set(userId, fresh);
      userDb = fresh;
    }
    return userDb;
  }

  /**
   * Refuse (`true`) or accept (`false`, also the initial state) records of a
   * user id the users index does not hold: an erased account. Without effect
   * when the users index is not in this database.
   * @returns whether such records are refused from now on
   */
  refuseUnindexedUsers (on: boolean): boolean {
    this.guard.on = on && this.seesUsersIndex;
    return this.guard.on;
  }

  async deleteUser (userId: string): Promise<void> {
    this.logger.info('deleteUser: ' + userId);
    this.userDBsCache.delete(userId);
    await this.db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
    // The delete trigger removed the account's rows; this also removes what a
    // trigger disabled at some point left behind.
    await this.db.query('DELETE FROM audit_event_streams WHERE user_id = $1', [userId]);
  }

  close (): void {
    this.checkInitialized();
    this.userDBsCache.clear();
    if (this.db) this.db.close().catch(() => {});
    if (this.readDb && this.readDb !== this.db) this.readDb.close().catch(() => {});
  }
}

export { AuditStoragePG };
