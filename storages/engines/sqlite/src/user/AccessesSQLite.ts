/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId, UpdateData, FindOptions } from '../../../../interfaces/_shared/types.ts';
import type { StoredAccess } from '../../../../interfaces/_shared/domain.ts';
import type { DbRow } from './BaseStorageSQLite.ts';
import type { SqliteDb, SqlParam } from '../types.ts';
import type { JsonGuard, JsonSet } from '../../../../interfaces/_shared/jsonPath.ts';
import type { TokenProtection, ExportAccessesOptions } from '../../../../interfaces/_shared/tokenProtection.ts';
import { itemsReportingUnreadable, isSealedValue, SEALED_PREFIX, refuseIntegrityValueCondition } from '../../../../interfaces/_shared/tokenProtection.ts';
const require = createRequire(import.meta.url);

/** `data.integrity` stored in clear (a row not converted yet). */
const CLEAR_INTEGRITY_SQL = '(json_extract(data, \'$.integrity\') IS NOT NULL AND substr(json_extract(data, \'$.integrity\'), 1, 7) <> \'sealed:\')';
/** `data.integrity` stored sealed (under any key). */
const SEALED_INTEGRITY_SQL = '(substr(json_extract(data, \'$.integrity\'), 1, 7) = \'sealed:\')';
const { foreignKeyError } = require('../../../../interfaces/_shared/tokenProtection.ts');

const { BaseStorageSQLite, decorateSQLiteDuplicateError } = require('./BaseStorageSQLite.ts') as typeof import('./BaseStorageSQLite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
// Bearer secrets from node:crypto (ids keep cuid2).
const { secureToken } = require('../../../../interfaces/_shared/secureToken.ts');
const timestamp = require('unix-timestamp');
const fs = require('fs');
const path = require('path');
const { _internals } = require('../_internals.ts');
const concurrentSafeWrite = require('../concurrentSafeWrite.ts');

const logger = _internals.lazyLogger('storage:accesses-sqlite');

type IntegrityAccesses = {
  isActive: boolean;
  set: (access: AccessItem, recompute?: boolean) => void;
  /** The previous (row-form) hash; the upgrade pass refuses to run without it. */
  rowFormHash: (access: AccessItem) => string;
};
/** Failed user ids named in the summary warning (the per-user errors name them all). */
const MAX_FAILED_USERS_LISTED = 20;
type RecomputeResult = { scanned: number; rewritten: number; unverified: number; failedUsers: number };

/** Rows whose stored form differs from the wire form (see `composeWireAccess`). */
const VERSIONED_ROWS_WHERE = 'head_id IS NOT NULL' +
  ' OR json_extract(data, \'$.serial\') IS NOT NULL' +
  ' OR json_extract(data, \'$.modifiedBySerial\') IS NOT NULL' +
  ' OR json_extract(data, \'$.createdBySerial\') IS NOT NULL';

/** Written in the users base directory once the recompute below completed. */
const INTEGRITY_WIRE_FORM_MARKER = 'accesses-integrity-wire-form.done';
/** Storage item for this collection — the canonical stored shape (the
 *  previous local type was misnamed AccessItem; rows are the base's DbRow). */
type AccessItem = StoredAccess;
type AccessUpdate = UpdateData & { modified?: number; integrity?: string | null };

/**
 * Fail loudly, at the write site, if integrity is active but the access
 * about to be persisted carries no `integrity` value. Without this the
 * gap only surfaces one operation later, when a full-store integrity scan
 * reports "access has no integrity property" — far from the write that
 * produced it. With the integrity ref now a required constructor arg, the
 * remaining root cause this guards is a business-side `set()` that failed
 * to stamp.
 */
function assertIntegritySet (access: AccessItem): void {
  if (access.integrity != null) return;
  throw new Error(
    'access persisted without an integrity property while integrity is active' +
    ' (name=' + JSON.stringify(access.name) + ', id=' + JSON.stringify(access.id) +
    ', pid=' + process.pid + ')'
  );
}

/** An access whose stored token does not open: never returned without its token. */
function tokenUnreadable (accessId: unknown, reason: string): Error {
  const err = new Error('access ' + JSON.stringify(accessId) + ': stored token unreadable (' + reason + ')') as Error & { accessId: unknown };
  err.name = 'TokenUnreadableError';
  err.accessId = accessId;
  return err;
}

function requireUserId (userId: string | null | undefined): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('AccessesSQLite: the user id of the database is required to read or write a token');
  }
  return userId;
}

type UserDbHandle = { db: SqliteDb, userId?: string | null, readyTables?: Set<string> };
type TokenPassResult = { rows: number; skipped: number };

class AccessesSQLite extends BaseStorageSQLite<AccessItem> {
  integrityAccesses: IntegrityAccesses;
  tokenProtection: TokenProtection;

  constructor (integrityAccesses: IntegrityAccesses, tokenProtection: TokenProtection) {
    super();
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = true;
    this.defaultSort = 'json_extract(data, \'$.name\') ASC';
    if (integrityAccesses == null) {
      throw new Error(
        'AccessesSQLite requires an integrityAccesses ref — pass ' +
        '{ isActive: false, set: () => {} } explicitly for integrity-less contexts'
      );
    }
    if (tokenProtection == null) {
      throw new Error('AccessesSQLite requires a tokenProtection ref (access tokens are never stored in clear)');
    }
    this.integrityAccesses = integrityAccesses;
    this.tokenProtection = tokenProtection;
  }

  // ---- Token at rest: `token` (item) <-> `tokenHash` + `tokenEnc` (data JSON) ----
  // The item above this class always carries the clear token; the stored data
  // never does once converted (see `protectClearRowsOfUser`).

  /** Whether the stored data holds an `integrity` value in clear. */
  static hasClearIntegrity (data: Record<string, unknown>): boolean {
    return typeof data.integrity === 'string' && !isSealedValue(data.integrity);
  }

  /**
   * The stored data with `token` replaced by its pair and a clear `integrity`
   * sealed, in place (key order kept).
   */
  protectData (userId: string, data: Record<string, unknown>): Record<string, unknown> {
    const sealIntegrity = AccessesSQLite.hasClearIntegrity(data);
    if (data.token == null && !sealIntegrity) return data;
    let tokenHash: string | null = null;
    let tokenEnc: string | null = null;
    if (data.token != null) {
      if (typeof data.token !== 'string') throw new TypeError('accesses: token must be a string');
      tokenHash = this.tokenProtection.hashAccessToken(userId, data.token);
      tokenEnc = this.tokenProtection.sealAccessToken(userId, tokenHash, data.token);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === 'integrity' && sealIntegrity) out[k] = this.tokenProtection.sealAccessIntegrity(userId, v as string);
      else if (tokenHash == null) out[k] = v;
      else if (k === 'token') { out.tokenHash = tokenHash; out.tokenEnc = tokenEnc; } else if (k !== 'tokenHash' && k !== 'tokenEnc') out[k] = v;
    }
    return out;
  }

  /**
   * The public `integrity` of a stored value: a clear one as stored, a sealed
   * one opened. One that does not open is logged (ids only) and gives
   * undefined: the item is returned without it.
   */
  openedIntegrity (userId: string | null | undefined, stored: unknown, accessId: unknown): unknown {
    if (!isSealedValue(stored)) return stored;
    try {
      return this.tokenProtection.openAccessIntegrity(requireUserId(userId), stored);
    } catch (err) {
      logger.error('access ' + JSON.stringify(accessId) + ' of user ' + JSON.stringify(userId) +
        ': stored integrity unreadable, returned without it (' + (err as Error).message + ')');
      return undefined;
    }
  }

  /** The stored data with its pair opened back to `token` and its `integrity` opened (key order kept). */
  openData (userId: string | null | undefined, data: Record<string, unknown>, accessId: unknown): Record<string, unknown> {
    if (isSealedValue(data.integrity)) {
      data = Object.assign({}, data);
      const opened = this.openedIntegrity(userId, data.integrity, accessId);
      if (opened === undefined) delete data.integrity; else data.integrity = opened;
    }
    if (data.tokenEnc == null && !('tokenHash' in data)) return data;
    // A clear token (data not converted yet) is authoritative over a pair.
    let token: unknown = data.token;
    if (token == null && data.tokenEnc != null) {
      if (typeof data.tokenHash !== 'string') throw tokenUnreadable(accessId, 'the row has an encrypted token without its hash');
      try {
        token = this.tokenProtection.openAccessToken(requireUserId(userId), data.tokenHash, data.tokenEnc as string);
      } catch (err) {
        throw tokenUnreadable(accessId, (err as Error).message);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === 'tokenHash') { if (token != null) out.token = token; } else if (k !== 'tokenEnc' && k !== 'token') out[k] = v;
    }
    if (out.token == null && token != null) out.token = token;
    return out;
  }

  protected itemToRow (item: Partial<AccessItem>, userId?: string | null): { id: string, head_id: SqlParam, deleted: SqlParam, data: string } {
    if (item.token == null && !AccessesSQLite.hasClearIntegrity(item as Record<string, unknown>)) return super.itemToRow(item, userId);
    return super.itemToRow(this.protectData(requireUserId(userId), item as Record<string, unknown>), userId);
  }

  /**
   * With `options.onUnreadableRow` (a whole-store read made for a report, the
   * integrity check), a row whose token does not open is reported there and
   * left out instead of failing the read. Without it the read throws, as every
   * lookup does. A database holding rows under another key still fails as a
   * whole (its first-use check).
   */
  exportAll (userOrUserId: UserOrId, callback: Callback<Array<AccessItem | null>>, options?: ExportAccessesOptions): void {
    const report = options?.onUnreadableRow;
    if (report == null) return super.exportAll(userOrUserId, callback);
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const rows = udb.db.prepare<DbRow>('SELECT * FROM accesses').all();
      callback(null, itemsReportingUnreadable(rows, (r: DbRow) => this.rowToItem(r, udb.userId), report));
    });
  }

  rowToItem (row: DbRow, userId?: string | null): AccessItem | null {
    let item = super.rowToItem(row, userId);
    if (item != null) item = this.openData(userId, item as Record<string, unknown>, row.id) as AccessItem;
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    return item;
  }

  /** Rewrites a `token` condition into one on `tokenHash`. */
  tokenCondition (userId: string, value: unknown): unknown {
    const hash = (v: unknown): unknown => {
      if (v === null || v === undefined) return v;
      if (typeof v !== 'string') throw new TypeError('accesses: a token condition takes strings');
      return this.tokenProtection.hashAccessToken(userId, v);
    };
    if (value === null || value === undefined || typeof value !== 'object') return hash(value);
    if (Array.isArray(value)) throw new TypeError('accesses: unsupported token condition');
    const out: Record<string, unknown> = {};
    for (const [op, v] of Object.entries(value as Record<string, unknown>)) {
      if (op === '$eq' || op === '$ne') out[op] = hash(v);
      else if (op === '$in' && Array.isArray(v)) out[op] = v.map(hash);
      else throw new TypeError('accesses: unsupported token condition operator ' + JSON.stringify(op));
    }
    return out;
  }

  buildWhere (query: Record<string, unknown>, userId?: string | null): { sql: string, params: SqlParam[] } {
    if (query == null) return super.buildWhere(query, userId);
    refuseIntegrityValueCondition(query);
    const hasOrToken = Array.isArray(query.$or) && (query.$or as Array<Record<string, unknown>>).some((c) => c != null && 'token' in c);
    if (!('token' in query) && !hasOrToken) return super.buildWhere(query, userId);
    const uid = requireUserId(userId);
    const q: Record<string, unknown> = Object.assign({}, query);
    if ('token' in q) {
      q.tokenHash = this.tokenCondition(uid, q.token);
      delete q.token;
    }
    if (hasOrToken) {
      q.$or = (query.$or as Array<Record<string, unknown>>).map((clause) => {
        if (clause == null || !('token' in clause)) return clause;
        // Same contract as the PostgreSQL engine: a plain value inside `$or`.
        if (clause.token != null && typeof clause.token === 'object') {
          throw new TypeError('accesses: a token condition inside $or takes a plain value');
        }
        const c: Record<string, unknown> = Object.assign({}, clause);
        c.tokenHash = this.tokenCondition(uid, clause.token);
        delete c.token;
        return c;
      });
    }
    return super.buildWhere(q, userId);
  }

  compareAndSetJson (userOrUserId: UserOrId, query: Record<string, unknown>, guards: JsonGuard[], sets: JsonSet[], callback: Callback<boolean>): void {
    const tokenPaths = new Set(['token', 'tokenHash', 'tokenEnc']);
    if ([...(guards || []), ...(sets || [])].some((g) => tokenPaths.has(g.path?.[0]))) {
      return callback(new Error('compareAndSetJson: the token is not a JSON field of accesses'));
    }
    if ([...(guards || []), ...(sets || [])].some((g) => g.path?.[0] === 'integrity')) {
      return callback(new Error('compareAndSetJson: the integrity of an access is stored sealed, not a JSON field'));
    }
    super.compareAndSetJson(userOrUserId, query, guards, sets, callback);
  }

  /**
   * Before the first use of a user's database in this process: refuse rows
   * protected under another key, convert the rows still holding a clear token
   * (a database restored by file copy, or missed by the start-up walk). After
   * `bin/access-tokens.js unprotect` (its marker present), only the check
   * runs: a tool run before the rollback must not protect the rows again.
   */
  protected async onUserDbReady (udb: UserDbHandle): Promise<void> {
    if (udb.readyTables?.has('accesses')) return;
    if (tokensUnprotected()) {
      if (this.hasForeignKeyRowsOfUser(udb)) throw foreignKeyError('access rows of user ' + requireUserId(udb.userId));
      return; // not marked ready: converted at first use once the marker is gone
    }
    await this.protectClearRowsOfUser(udb);
    udb.readyTables?.add('accesses');
  }

  /** Whether a user's database holds rows protected under another key. */
  hasForeignKeyRowsOfUser (udb: UserDbHandle): boolean {
    const kid = this.tokenProtection.kid;
    const sealedOwn = SEALED_PREFIX + kid + '.';
    return udb.db.prepare('SELECT 1 FROM accesses WHERE (json_extract(data, \'$.tokenHash\') IS NOT NULL' +
      ' AND json_extract(data, \'$.token\') IS NULL AND substr(json_extract(data, \'$.tokenHash\'), 1, ?) <> ?)' +
      ' OR (' + SEALED_INTEGRITY_SQL + ' AND substr(json_extract(data, \'$.integrity\'), 1, ?) <> ?) LIMIT 1')
      .get(kid.length + 1, kid + '.', sealedOwn.length, sealedOwn) != null;
  }

  /**
   * Convert, in one write transaction, every row of a user's database holding
   * a clear token or a clear `integrity` (live, deleted, history); the clear
   * token is authoritative over a pair already there. Throws when rows are
   * under another key. Idempotent.
   */
  async protectClearRowsOfUser (udb: UserDbHandle): Promise<number> {
    const userId = requireUserId(udb.userId);
    if (this.hasForeignKeyRowsOfUser(udb)) throw foreignKeyError('access rows of user ' + userId);
    const toConvert = '(json_extract(data, \'$.token\') IS NOT NULL OR ' + CLEAR_INTEGRITY_SQL + ')';
    if (udb.db.prepare('SELECT 1 FROM accesses WHERE ' + toConvert + ' LIMIT 1').get() == null) return 0;
    let count = 0;
    const unreadable: unknown[] = [];
    await concurrentSafeWrite.execute(() => udb.db.transaction(() => {
      const rows = udb.db.prepare<DbRow>('SELECT id, data FROM accesses WHERE ' + toConvert).all();
      // Compare-and-set on the whole stored data (one write transaction).
      const upd = udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ? AND data = ?');
      for (const row of rows) {
        const data = JSON.parse(row.data as string);
        // A legacy token stored as a number or a boolean: its string form.
        if (typeof data.token === 'number' || typeof data.token === 'boolean') data.token = String(data.token);
        if (data.token != null && typeof data.token !== 'string') { unreadable.push(row.id); continue; }
        count += upd.run(JSON.stringify(this.protectData(userId, data)), row.id, row.data).changes;
      }
    }).immediate());
    if (count > 0) logger.info('access tokens at rest: ' + count + ' access rows of user ' + userId + ' protected');
    if (unreadable.length > 0) {
      logger.error('access tokens at rest: user ' + userId + ': access(es) ' + unreadable.map((id) => JSON.stringify(id)).join(', ') +
        ' hold a token that is not a string; left unconverted');
    }
    return count;
  }

  /**
   * Rollback aid: the clear token written back, the pair dropped, the public
   * `integrity` written back in clear (one that does not open is left sealed
   * and logged).
   */
  async unprotectRowsOfUser (udb: UserDbHandle): Promise<number> {
    const userId = requireUserId(udb.userId);
    let count = 0;
    await concurrentSafeWrite.execute(() => udb.db.transaction(() => {
      const rows = udb.db.prepare<DbRow>('SELECT id, data FROM accesses WHERE json_extract(data, \'$.tokenEnc\') IS NOT NULL' +
        ' OR ' + SEALED_INTEGRITY_SQL).all();
      const upd = udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ? AND data = ?');
      for (const row of rows) {
        const stored = JSON.parse(row.data as string);
        const data = this.openData(userId, stored, row.id);
        // unreadable: left as stored (the previous image reports it), never dropped here
        if (stored.integrity != null && data.integrity === undefined) data.integrity = stored.integrity;
        count += upd.run(JSON.stringify(data), row.id, row.data).changes;
      }
    }).immediate());
    return count;
  }

  /**
   * Re-hash and re-seal under the configured key the rows protected under one
   * of `previous` (token pair and sealed `integrity`, each recognised by its
   * key id). A value under a key not given is left and counted as skipped.
   */
  async rekeyRowsOfUser (udb: UserDbHandle, previous: TokenProtection[]): Promise<TokenPassResult> {
    const userId = requireUserId(udb.userId);
    const result: TokenPassResult = { rows: 0, skipped: 0 };
    const tp = this.tokenProtection;
    await concurrentSafeWrite.execute(() => udb.db.transaction(() => {
      const rows = udb.db.prepare<DbRow>('SELECT id, data FROM accesses WHERE (json_extract(data, \'$.tokenEnc\') IS NOT NULL' +
        ' AND json_extract(data, \'$.token\') IS NULL) OR ' + SEALED_INTEGRITY_SQL).all();
      const upd = udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ? AND data = ?');
      for (const row of rows) {
        let data: Record<string, unknown> = JSON.parse(row.data as string);
        let changed = false;
        let skipped = false;
        if (data.tokenEnc != null && data.token == null && !tp.ownsHash(data.tokenHash as string)) {
          const from = previous.find((p) => p.ownsHash(data.tokenHash as string));
          if (from == null) skipped = true;
          else {
            const token = from.openAccessToken(userId, data.tokenHash as string, data.tokenEnc as string);
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) {
              if (k === 'tokenHash') out.token = token; else if (k !== 'tokenEnc') out[k] = v;
            }
            data = this.protectData(userId, out);
            changed = true;
          }
        }
        if (isSealedValue(data.integrity) && !tp.ownsSealed(data.integrity)) {
          const stored = data.integrity;
          const from = previous.find((p) => p.ownsSealed(stored));
          if (from == null) skipped = true;
          else {
            data = Object.assign({}, data, { integrity: tp.sealAccessIntegrity(userId, from.openAccessIntegrity(userId, stored)) });
            changed = true;
          }
        }
        if (skipped) result.skipped++;
        if (changed) result.rows += upd.run(JSON.stringify(data), row.id, row.data).changes;
      }
    }).immediate());
    return result;
  }

  /** Counts per stored form in a user's database. */
  tokenStatusOfUser (udb: UserDbHandle): Array<{ k: string, n: number }> {
    return udb.db.prepare<{ k: string, n: number }>('SELECT CASE WHEN json_extract(data, \'$.token\') IS NOT NULL THEN \'clear\'' +
      ' WHEN json_extract(data, \'$.tokenHash\') IS NULL THEN \'none\' ELSE substr(json_extract(data, \'$.tokenHash\'), 1, 8) END AS k,' +
      ' COUNT(*) AS n FROM accesses GROUP BY 1').all();
  }

  /** Counts per stored form of `integrity` in a user's database (`k`: 'none', 'clear' or the key id). */
  integrityStatusOfUser (udb: UserDbHandle): Array<{ k: string, n: number }> {
    return udb.db.prepare<{ k: string, n: number }>('SELECT CASE WHEN json_extract(data, \'$.integrity\') IS NULL THEN \'none\'' +
      ' WHEN ' + CLEAR_INTEGRITY_SQL + ' THEN \'clear\' ELSE substr(json_extract(data, \'$.integrity\'), 8, 8) END AS k,' +
      ' COUNT(*) AS n FROM accesses GROUP BY 1').all();
  }

  // ---- Tokens of deleted accesses ----

  /**
   * Drop the token (clear, hash and encrypted copy) of every deleted row, and
   * of every history row whose head is deleted, in a user's database, inside
   * the caller's write transaction. `modified` is untouched. While integrity
   * is active, a row whose stored integrity verifies on the row with its
   * token is re-hashed without it; any other value is kept as stored, for the
   * integrity check to report. Compare-and-set on the whole stored data.
   */
  _dropTokensOfDeletedRowsSync (udb: UserDbHandle): number {
    const userId = requireUserId(udb.userId);
    const rows = udb.db.prepare<DbRow>('SELECT a.* FROM accesses a WHERE (json_extract(a.data, \'$.token\') IS NOT NULL' +
      ' OR json_extract(a.data, \'$.tokenHash\') IS NOT NULL OR json_extract(a.data, \'$.tokenEnc\') IS NOT NULL)' +
      ' AND (a.deleted IS NOT NULL OR (a.head_id IS NOT NULL AND EXISTS (SELECT 1 FROM accesses d' +
      ' WHERE d.id = a.head_id AND d.deleted IS NOT NULL)))').all();
    const upd = udb.db.prepare('UPDATE accesses SET data = ? WHERE id = ? AND data = ?');
    let count = 0;
    for (const row of rows) {
      const data: Record<string, unknown> = JSON.parse(row.data as string);
      const out: Record<string, unknown> = Object.assign({}, data);
      delete out.token;
      delete out.tokenHash;
      delete out.tokenEnc;
      if (this.integrityAccesses.isActive && data.integrity != null) {
        let verifies = false;
        try {
          const withToken = this.rowToItem(row, userId);
          if (withToken?.integrity != null) {
            const check = Object.assign({}, withToken);
            this.integrityAccesses.set(check, true);
            verifies = check.integrity === withToken.integrity;
          }
        } catch (_e) {
          // the token does not open: the stored integrity cannot be verified, kept as stored
        }
        const without = verifies ? this.rowToItem(Object.assign({}, row, { data: JSON.stringify(out) }), userId) : null;
        if (without != null) {
          this.integrityAccesses.set(without, true);
          if (typeof without.integrity === 'string') out.integrity = this.tokenProtection.sealAccessIntegrity(userId, without.integrity);
        }
      }
      count += upd.run(JSON.stringify(out), row.id, row.data).changes;
    }
    if (count > 0) logger.info('access tokens at rest: token dropped from ' + count + ' deleted access rows of user ' + userId);
    return count;
  }

  /** `_dropTokensOfDeletedRowsSync` in its own write transaction. */
  async dropTokensOfDeletedRowsOfUser (udb: UserDbHandle): Promise<number> {
    let count = 0;
    await concurrentSafeWrite.execute(() => udb.db.transaction(() => { count = this._dropTokensOfDeletedRowsSync(udb); }).immediate());
    return count;
  }

  applyDefaults (item: Partial<AccessItem>): AccessItem {
    const copy = Object.assign({}, item) as AccessItem;
    copy.id = copy.id || generateId();
    // Only a live head gets a token: a deletion record or a history row
    // without one (dropped at deletion) is restored without one.
    if (!copy.token && copy.deleted == null && copy.headId == null) copy.token = secureToken();
    if (copy.deleted === undefined) copy.deleted = null;
    delete copy.apiEndpoint;
    if (this.integrityAccesses.isActive) {
      this.integrityAccesses.set(copy);
      assertIntegritySet(copy);
    }
    return copy;
  }

  generateToken (): string {
    return secureToken();
  }

  /** Query-shaped deletion lookup (accesses-specific; the base
   *  findDeletions keeps its deletedSince signature). */
  findDeletionRecords (userOrUserId: UserOrId, query: Record<string, unknown>, options: FindOptions, callback: Callback<Array<AccessItem | null>>): void {
    const q = Object.assign({}, query || {}, { deleted: { $ne: null } });
    this.findIncludingDeletionsAndVersions(userOrUserId, q, options, callback);
  }

  /**
   * Marks the matching accesses deleted. A deleted access never authenticates
   * and its token is never returned: the deletion record drops it, and so do
   * the history rows of the deleted accesses, in the same transaction (see
   * `_dropTokensOfDeletedRowsSync`). The integrity of each is computed on the
   * row without its token.
   */
  delete (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<{ modifiedCount: number; integrityRecomputed?: number }>): void {
    const now = timestamp.now();
    const updateData: AccessUpdate = {
      $set: { deleted: now },
      $unset: { integrity: 1, token: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
        const res = this._updateManySync(udb, query, updateData);
        this._dropTokensOfDeletedRowsSync(udb);
        return res;
      }).immediate());
      return;
    }

    const integrityBatchCode = Math.random();
    updateData.$set!.integrityBatchCode = integrityBatchCode;

    const updateIfNeeded = (access: AccessItem): AccessUpdate | null => {
      delete access.integrityBatchCode;
      const prev = access.integrity;
      this.integrityAccesses.set(access, true);
      if (prev === access.integrity) return null;
      return {
        $unset: { integrityBatchCode: 1 },
        $set: { integrity: access.integrity }
      };
    };

    // Batch-unset (statement 1) and the per-row recompute pass (statement 2)
    // run inside ONE better-sqlite3 transaction so a concurrent integrity scan
    // never sees a soft-deleted row while its hash is transiently absent.
    // The tx body must be synchronous — hence the *Sync cores.
    this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
      const res = this._updateManySync(udb, query, updateData);
      const res2 = this._findAndUpdateIfNeededSync(udb, { integrityBatchCode }, {}, updateIfNeeded);
      this._dropTokensOfDeletedRowsSync(udb);
      return { modifiedCount: res.modifiedCount, integrityRecomputed: res2.count };
    }).immediate());
  }

  updateOne (userOrUserId: UserOrId, query: Record<string, unknown>, update: AccessUpdate, callback: Callback<AccessItem | null>): void {
    if (update.modified == null || !this.integrityAccesses.isActive) {
      return this.findOneAndUpdate(userOrUserId, query, update, callback);
    }
    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }
    // Statement 1 (apply fields + unset integrity) and statement 2 (recompute +
    // set integrity) run inside ONE better-sqlite3 transaction so a concurrent
    // integrity scan never observes the row while its hash is transiently
    // absent. The tx body must be synchronous.
    this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
      const accessData = this._findOneAndUpdateSync(udb, query, update);
      if (accessData?.id == null) return accessData ?? null;
      const before = accessData.integrity;
      this.integrityAccesses.set(accessData, true);
      if (before !== accessData.integrity) {
        return this._findOneAndUpdateSync(udb, { id: accessData.id }, { integrity: accessData.integrity });
      }
      return accessData;
    }).immediate());
  }

  async findHistory (userOrUserId: UserOrId, baseId: string): Promise<AccessItem[]> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
    await this.onUserDbReady(udb);
    const rows = udb.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE head_id = ? ORDER BY json_extract(data, '$.modified') ASC`
    ).all(baseId);
    return rows.map((r: DbRow) => this.rowToItem(r, userId)).filter((x: AccessItem | null): x is AccessItem => x != null);
  }

  snapshotHead (userOrUserId: UserOrId, baseId: string, callback: Callback<void>): void {
    this.findOne(userOrUserId, { id: baseId }, null, (err: Error | null, head?: AccessItem | null) => {
      if (err) return callback(err);
      if (head == null) return callback(new Error('snapshotHead: no live head row for access id ' + JSON.stringify(baseId)));
      const snapshot = Object.assign({}, head);
      snapshot.id = generateId();
      snapshot.headId = baseId;
      delete snapshot.integrity;
      delete snapshot.apiEndpoint;
      this.insertOne(userOrUserId, snapshot, (err2: Error | null) => callback(err2 || null));
    });
  }

  /**
   * One-time upgrade pass: re-hash the rows whose stored form differs from
   * the wire form (updated accesses, their history rows and deletion
   * records) so their `integrity` verifies on what the API returns. A row is
   * rewritten only when its stored value is the hash of the row itself (the
   * previous computation): any other value is left for the integrity check
   * to report, never replaced. Idempotent: a second run rewrites nothing.
   * Walks every user directory (the users index may lack some).
   */
  async recomputeIntegrityOfVersionedRows (): Promise<RecomputeResult> {
    const result: RecomputeResult = { scanned: 0, rewritten: 0, unverified: 0, failedUsers: 0 };
    if (!this.integrityAccesses.isActive) return result;
    const rowForm = this.integrityAccesses.rowFormHash;
    if (typeof rowForm !== 'function') {
      // Without the previous hash a row cannot be checked before it is
      // rewritten: refuse rather than bless a value nobody verified.
      throw new Error('access integrity recompute needs integrityAccesses.rowFormHash');
    }
    const failed: string[] = [];
    for (const userId of await _internals.userLocalDirectory.listUserIds() as string[]) {
      if (!fs.existsSync(UserBaseStorageDb.existingPathForUser(userId))) continue;
      try {
        const udb: { db: SqliteDb } = await UserBaseStorageDb.forUser(userId);
        const hasTable = udb.db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(this.tableName) != null;
        if (!hasTable) continue;
        await concurrentSafeWrite.execute(() => udb.db.transaction(() => {
          const rows = udb.db.prepare<DbRow>(`SELECT * FROM ${this.tableName} WHERE ${VERSIONED_ROWS_WHERE}`).all();
          const write = udb.db.prepare(`UPDATE ${this.tableName} SET data = json_set(data, '$.integrity', ?)` +
            ' WHERE id = ? AND json_extract(data, \'$.integrity\') = ?');
          for (const row of rows) {
            const item = this.rowToItem(row, userId);
            if (item == null || item.integrity == null) continue;
            result.scanned++;
            const stored = item.integrity;
            this.integrityAccesses.set(item, true);
            if (item.integrity === stored) continue;
            // `set()` replaced `item.integrity`; the row-form hash is still the
            // hash of the row, as `stableRepresentation.access.hash` deletes
            // `integrity` before stringifying.
            if (rowForm(item) !== stored) {
              result.unverified++;
              continue;
            }
            // Compare-and-set on the stored (raw) value, clear or sealed; the new value written sealed.
            const raw = JSON.parse(row.data as string).integrity;
            result.rewritten += write.run(this.tokenProtection.sealAccessIntegrity(userId, item.integrity as string), row.id, raw).changes;
          }
        }).immediate());
      } catch (err) {
        result.failedUsers++;
        failed.push(userId);
        logger.error('access integrity recompute failed for user ' + userId + ': ' + (err as Error).message);
      }
    }
    logger.info('access integrity recompute: ' + result.scanned + ' versioned rows scanned, ' +
      result.rewritten + ' rewritten, ' + result.unverified + ' left as stored (not the previous row hash)' +
      (result.failedUsers > 0 ? ', ' + result.failedUsers + ' user databases failed' : ''));
    if (failed.length > 0) {
      logger.warn('access integrity recompute: the pass runs again at every start until every user database' +
        ' succeeds; failed: ' + failed.slice(0, MAX_FAILED_USERS_LISTED).join(', ') +
        (failed.length > MAX_FAILED_USERS_LISTED ? ' and ' + (failed.length - MAX_FAILED_USERS_LISTED) + ' more' : ''));
    }
    return result;
  }

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    const prepared = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    // The base `insertMany` is `importAll`: the rows only, without the token
    // drop of a restore (see `importAll` below).
    super.importAll(userOrUserId, prepared, callback);
  }

  /**
   * A restore: a backup taken before deleted accesses dropped their token
   * still carries it on deletion records and their history rows; it goes
   * after the import, as at deletion.
   */
  importAll (userOrUserId: UserOrId, items: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    super.importAll(userOrUserId, items, (err: Error | null) => {
      if (err || !items || items.length === 0) return callback(err);
      this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
        this._dropTokensOfDeletedRowsSync(udb);
        return undefined;
      }).immediate());
    });
  }

  /**
   * Override `insertOne` to enforce the same uniqueness invariants the PG
   * engine gets from UNIQUE INDEX `idx_access_token` + `idx_access_name_type_deviceName`
   * (both `WHERE deleted IS NULL`). SQLite stores access fields inside a
   * JSON `data` TEXT column, so we can't lean on a SQLite-side UNIQUE
   * constraint; check at the JS layer before INSERT and throw an error
   * shaped like PG's so api-server's `err.isDuplicateIndex('token')` /
   * `'name'` / `'type'` / `'deviceName'` branches keep matching.
   */
  insertOne (userOrUserId: UserOrId, item: Partial<AccessItem>, callback: Callback<AccessItem | null>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(Object.assign({ deleted: null }, item));
    // Versioned snapshots (headId != null) bypass the uniqueness check —
    // PG's `idx_access_token` predicate is `WHERE deleted IS NULL AND
    // head_id IS NULL`, so multiple snapshots sharing token/name with a
    // live head are allowed there too.
    if (prepared.headId != null) {
      return super.insertOne(userId, prepared, callback);
    }
    // Check and insert in one write transaction (BEGIN IMMEDIATE): as two
    // steps, two concurrent inserts (two logins for the same app, in this
    // process or another) could both pass the check.
    const duplicateAwareCallback: Callback<AccessItem | null> = (err, result) => {
      if (err != null) decorateSQLiteDuplicateError(err);
      callback(err, result);
    };
    // Compared on the stored form: the keyed hash of the token, no envelope opened.
    const preparedHash = prepared.token != null ? this.tokenProtection.hashAccessToken(userId, prepared.token) : null;
    this._userDbAndWrite(userId, duplicateAwareCallback, (udb) => udb.db.transaction(() => {
      const { sql: where, params } = this.buildWhere({ deleted: null, headId: null }, userId);
      const rows = udb.db.prepare<DbRow>(`SELECT * FROM ${this.tableName} ${where}`.trim()).all(...params);
      for (const row of rows) {
        const ex = Object.assign(JSON.parse(row.data || '{}'), { id: row.id }) as AccessItem & { tokenHash?: string };
        if (ex.id === prepared.id) continue; // same row (should not happen, defensive)
        const sameToken = ex.token != null ? ex.token === prepared.token : (ex.tokenHash != null && ex.tokenHash === preparedHash);
        if (preparedHash != null && sameToken) {
          throw duplicateIndexError(['token'], { token: '(hidden)' });
        }
        if (ex.name != null && ex.type != null &&
            ex.name === prepared.name &&
            ex.type === prepared.type &&
            (ex.deviceName ?? null) === (prepared.deviceName ?? null)) {
          throw duplicateIndexError(['name', 'type', 'deviceName'], {
            name: prepared.name, type: prepared.type, deviceName: prepared.deviceName ?? null
          });
        }
      }
      return this._insertOneSync(udb, prepared);
    }).immediate());
  }
}

/**
 * Build a duplicate-key error that mimics the shape attached by
 * `DatabasePG.handleDuplicateError`. The api-server methods only call
 * `err.isDuplicateIndex(key)` (not `err.code`), so a thin shim is enough.
 */
function duplicateIndexError (constraintKeys: string[], data: Record<string, unknown>): Error & { isDuplicate: boolean; duplicateKeys: string[]; data: Record<string, unknown>; isDuplicateIndex: (key: string) => boolean } {
  const err = new Error('duplicate key') as Error & { isDuplicate: boolean; duplicateKeys: string[]; data: Record<string, unknown>; isDuplicateIndex: (key: string) => boolean };
  err.isDuplicate = true;
  err.duplicateKeys = constraintKeys;
  err.data = data;
  err.isDuplicateIndex = (key: string): boolean => {
    return constraintKeys.includes(key);
  };
  return err;
}

/**
 * Run `recomputeIntegrityOfVersionedRows` once per users base directory: the
 * SQLite engine has no schema-migration runner, so a marker file records that
 * it completed (written only when every user database was processed; a
 * failure is retried at the next start). Returns null when skipped: marker
 * present, integrity inactive, or the users directory not initialised in this
 * process (the supervisor: its workers and the admin tools run it).
 */
async function recomputeAccessesIntegrityOnce (accesses: AccessesSQLite): Promise<RecomputeResult | null> {
  if (!accesses.integrityAccesses.isActive) return null;
  let basePath: string;
  try {
    basePath = _internals.userLocalDirectory.getBasePath();
  } catch (_e) {
    return null;
  }
  const marker = path.join(basePath, INTEGRITY_WIRE_FORM_MARKER);
  if (fs.existsSync(marker)) return null;
  const result = await accesses.recomputeIntegrityOfVersionedRows();
  if (result.failedUsers === 0) {
    fs.writeFileSync(marker, 'DO NOT DELETE THIS FILE - IT RECORDS THAT THE ACCESS INTEGRITY RECOMPUTE COMPLETED');
  }
  return result;
}

/**
 * After a conversion, rewrite the database file so the clear values left in
 * free pages and in the write-ahead log are gone. Never fails the caller: a
 * busy database keeps them until its next VACUUM (see the operator notes).
 */
function vacuumQuietly (db: SqliteDb, what: string): void {
  try {
    db.prepare('VACUUM').run();
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
  } catch (err) {
    logger.warn('access tokens at rest: VACUUM of ' + what + ' skipped: ' + (err as Error).message);
  }
}

/** Written in the users base directory once every user database was converted; holds the key id. */
const TOKEN_PROTECTED_MARKER = 'accesses-token-protected.done';

type UserDbVisitor = (udb: UserDbHandle, userId: string) => Promise<void>;

/** Visit every user database holding an accesses table; returns the users whose visit failed. */
async function eachUserAccessesDb (visit: UserDbVisitor): Promise<string[]> {
  const failed: string[] = [];
  for (const userId of await _internals.userLocalDirectory.listUserIds() as string[]) {
    if (!fs.existsSync(UserBaseStorageDb.existingPathForUser(userId))) continue;
    try {
      const udb: UserDbHandle = await UserBaseStorageDb.forUser(userId);
      const hasTable = udb.db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get('accesses') != null;
      if (!hasTable) continue;
      await visit(udb, userId);
    } catch (err) {
      if ((err as Error).name === 'ForeignTokenKeyError') throw err;
      failed.push(userId);
      logger.error('access tokens at rest: user ' + userId + ' failed: ' + (err as Error).message);
    }
  }
  return failed;
}

/**
 * Written in the users base directory by `bin/access-tokens.js unprotect`;
 * removed by the conversion pass of the start (`protectTokensAtRest`). While
 * it is there, no other process converts rows (see `tokensUnprotected`).
 */
const TOKEN_UNPROTECTED_MARKER = 'accesses-token-unprotected';

/**
 * The users base directory, also in a process that did not initialise the
 * users directory yet (the engine configuration names it); null when unknown.
 */
function usersBasePath (): string | null {
  try {
    return _internals.userLocalDirectory.getBasePath();
  } catch (_e) {
    const configured = (_internals.config as { path?: unknown } | undefined)?.path;
    return typeof configured === 'string' && configured !== '' && configured !== 'REPLACE ME' ? configured : null;
  }
}

function tokenMarkerPath (): string | null {
  const base = usersBasePath();
  return base == null ? null : path.join(base, TOKEN_PROTECTED_MARKER);
}

function unprotectedMarkerPath (): string | null {
  const base = usersBasePath();
  return base == null ? null : path.join(base, TOKEN_UNPROTECTED_MARKER);
}

/**
 * Whether `unprotect` ran and no start converted the rows since: tools and
 * first uses then leave the rows in clear (for the previous image).
 */
function tokensUnprotected (): boolean {
  const marker = unprotectedMarkerPath();
  return marker != null && fs.existsSync(marker);
}

function writeUnprotectedMarker (): void {
  const marker = unprotectedMarkerPath();
  if (marker == null) throw new Error('access tokens at rest: the users directory is unknown, cannot record the rollback');
  fs.writeFileSync(marker, 'DO NOT DELETE THIS FILE BEFORE STARTING THE PREVIOUS IMAGE - IT KEEPS THE TOKENS IN CLEAR FOR A ROLLBACK\n');
}

function removeUnprotectedMarker (): void {
  const marker = unprotectedMarkerPath();
  if (marker != null) fs.rmSync(marker, { force: true });
}

/**
 * The walk the marker's first line records after the key id. `v2`: tokens
 * protected, `integrity` sealed, deleted accesses without their token. A
 * marker without it (written by an earlier build) is a walk to do again, not
 * a marker of another key.
 */
const TOKEN_WALK_VERSION = 'v2';

/** The first line of the marker: `[kid, walk version]`, null when no walk completed. */
function tokenMarkerLine (): [string, string | null] | null {
  const marker = tokenMarkerPath();
  if (marker == null || !fs.existsSync(marker)) return null;
  const parts = fs.readFileSync(marker, 'utf8').split('\n')[0].trim().split(/\s+/);
  return [parts[0], parts[1] ?? null];
}

/** The key id recorded by the last complete walk, null when none completed. */
function tokenMarkerKid (): string | null {
  return tokenMarkerLine()?.[0] ?? null;
}

/** The walk version recorded with the key id (null: an earlier walk, or none). */
function tokenMarkerVersion (): string | null {
  return tokenMarkerLine()?.[1] ?? null;
}

function writeTokenMarker (kid: string, version: string | null = TOKEN_WALK_VERSION): void {
  const marker = tokenMarkerPath();
  if (marker == null) return;
  fs.writeFileSync(marker, kid + (version != null ? ' ' + version : '') +
    '\nDO NOT DELETE THIS FILE - IT RECORDS THAT THE ACCESS TOKENS ARE PROTECTED AT REST UNDER THIS KEY ID\n');
}

function removeTokenMarker (): void {
  const marker = tokenMarkerPath();
  if (marker != null) fs.rmSync(marker, { force: true });
}

/**
 * Convert every user database once (the marker file records the walk, with
 * the key id and the walk version): tokens and `integrity` in clear are
 * protected, deleted accesses and the history rows of deleted accesses drop
 * their token. Refused when the marker or a database is under another key. A
 * database the walk misses is converted at its first use (`onUserDbReady`),
 * tokens and `integrity` only: the token of a deleted access is left until
 * the next walk (`bin/hfs-author-scrub.js`, run before the first start, still
 * maps it). Returns null when skipped (marker of this walk for this key).
 */
async function protectAccessTokensOnce (accesses: AccessesSQLite): Promise<{ rows: number; deletedTokens: number; failedUsers: number } | null> {
  const markerKid = tokenMarkerKid();
  if (markerKid === accesses.tokenProtection.kid && tokenMarkerVersion() === TOKEN_WALK_VERSION) return null;
  if (markerKid != null && markerKid !== accesses.tokenProtection.kid) throw foreignKeyError('access rows (walk marker under key id ' + markerKid + ')');
  let rows = 0;
  let deletedTokens = 0;
  const failed = await eachUserAccessesDb(async (udb, userId) => {
    const n = await accesses.protectClearRowsOfUser(udb);
    const d = await accesses.dropTokensOfDeletedRowsOfUser(udb);
    rows += n;
    deletedTokens += d;
    if (n > 0 || d > 0) vacuumQuietly(udb.db, 'user ' + userId);
  });
  if (failed.length === 0) writeTokenMarker(accesses.tokenProtection.kid);
  else {
    logger.warn('access tokens at rest: the walk runs again at every start until every user database succeeds; failed: ' +
      failed.slice(0, MAX_FAILED_USERS_LISTED).join(', ') + (failed.length > MAX_FAILED_USERS_LISTED ? ' and ' + (failed.length - MAX_FAILED_USERS_LISTED) + ' more' : ''));
  }
  return { rows, deletedTokens, failedUsers: failed.length };
}

export {
  AccessesSQLite, duplicateIndexError, recomputeAccessesIntegrityOnce, INTEGRITY_WIRE_FORM_MARKER,
  TOKEN_PROTECTED_MARKER, protectAccessTokensOnce, eachUserAccessesDb, tokenMarkerKid, tokenMarkerVersion, writeTokenMarker, removeTokenMarker,
  TOKEN_WALK_VERSION,
  TOKEN_UNPROTECTED_MARKER, tokensUnprotected, writeUnprotectedMarker, removeUnprotectedMarker,
  vacuumQuietly
};
