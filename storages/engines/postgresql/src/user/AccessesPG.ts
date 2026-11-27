/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId, Query, UpdateData, FindOptions } from 'storages/interfaces/_shared/types.ts';
import type { StoredAccess } from 'storages/interfaces/_shared/domain.ts';
import type { PgDbLike } from './BaseStoragePG.ts';
import type { TokenProtection, ExportAccessesOptions } from '../../../../interfaces/_shared/tokenProtection.ts';
import {
  keyIdPrefixLength, keyIdPrefixesForeign, itemsReportingUnreadable, isSealedValue, SEALED_PREFIX, refuseIntegrityValueCondition
} from '../../../../interfaces/_shared/tokenProtection.ts';

const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG.ts') as typeof import('./BaseStoragePG.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
// Bearer secrets from node:crypto (ids keep cuid2).
const { secureToken } = require('../../../../interfaces/_shared/secureToken.ts');
const { _internals } = require('../_internals.ts');
const timestamp = require('unix-timestamp');

const logger = _internals.lazyLogger('storage:accesses-pg');

type IntegrityAccesses = {
  isActive: boolean;
  set: (item: AccessItem, deep?: boolean) => void;
  /** The previous (row-form) hash; the upgrade pass refuses to run without it. */
  rowFormHash: (item: AccessItem) => string;
};
/** Rows read per round trip by the upgrade pass (keyset on the primary key). */
const RECOMPUTE_BATCH_SIZE = 1000;
type RecomputeResult = { scanned: number; rewritten: number; unverified: number };
/** Storage item for this collection — the canonical stored shape. */
type AccessItem = StoredAccess;
type AccessRow = Record<string, unknown>;
type Update = UpdateData;
type Options = FindOptions;
/** `this.db` is a `DatabasePG` at runtime; the base only types the query slice
 *  it needs (`PgDbLike`). The integrity-preserving update/delete run their two
 *  statements inside `withTransaction` so no other connection can observe the
 *  hash-less intermediate row (the window in which an access row is briefly
 *  stored without its integrity hash). */
type PgDbWithTx = PgDbLike & { withTransaction: <R>(fn: (client: PgDbLike) => Promise<R>) => Promise<R> };

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

/** Result of a pass over the stored tokens (conversion, rollback, re-key). */
type TokenPassResult = { rows: number; skipped: number };
type TokenStatus = { clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> };
type IntegrityStatus = { clear: number; sealedCurrentKey: number; sealedOtherKeys: Record<string, number> };

/**
 * The rows whose `integrity` is still stored in clear. Must stay the literal
 * predicate of `idx_access_integrity_clear` (no bind parameter), so the probe
 * run at every start reads that index, empty in steady state.
 */
const CLEAR_INTEGRITY_WHERE = 'integrity IS NOT NULL AND integrity NOT LIKE \'sealed:%\'';
/** The rows whose `integrity` is sealed; predicate of `idx_access_integrity_kid`. */
const SEALED_INTEGRITY_WHERE = 'integrity LIKE \'sealed:%\'';
/** Accesses whose unreadable integrity was logged by this process (once each, bounded). */
const unreadableIntegrityLogged = new Set<string>();
function logUnreadableIntegrityOnce (userId: unknown, accessId: unknown, reason: string): void {
  const key = JSON.stringify([userId, accessId]);
  if (unreadableIntegrityLogged.has(key)) return;
  if (unreadableIntegrityLogged.size >= 10000) unreadableIntegrityLogged.clear();
  unreadableIntegrityLogged.add(key);
  logger.error('access ' + JSON.stringify(accessId) + ' of user ' + JSON.stringify(userId) +
    ': stored integrity unreadable, returned without it (' + reason + ')');
}

/** Length of `sealed:<kid>.` for an 8-character key id: the expression of `idx_access_integrity_kid`. */
function sealedPrefixLength (kid: string): number {
  return SEALED_PREFIX.length + keyIdPrefixLength(kid);
}

/**
 * PostgreSQL persistence for accesses.
 */
class AccessesPG extends BaseStoragePG<AccessItem> {
  integrityAccesses: IntegrityAccesses;

  tokenProtection: TokenProtection;

  /** Rows per statement of the conversion pass. */
  tokenBatchSize: number = RECOMPUTE_BATCH_SIZE;

  constructor (db: PgDbLike, integrityAccesses: IntegrityAccesses, tokenProtection: TokenProtection) {
    super(db);
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = true;
    this.defaultSort = 'name ASC';
    if (integrityAccesses == null) {
      throw new Error(
        'AccessesPG requires an integrityAccesses ref — pass ' +
        '{ isActive: false, set: () => {} } explicitly for integrity-less contexts'
      );
    }
    if (tokenProtection == null) {
      throw new Error('AccessesPG requires a tokenProtection ref (access tokens are never stored in clear)');
    }
    this.integrityAccesses = integrityAccesses;
    this.tokenProtection = tokenProtection;
  }

  // ---- Token at rest: `token` (item) <-> `token_hash` + `token_enc` (row) ----
  // The item above this class always carries the clear token; the row never
  // does (the `token` column stays NULL, see `protectClearRows`).

  /** The `token_hash` / `token_enc` pair for a token, `token` nulled. */
  protectedColumns (userId: string, token: string): Record<string, unknown> {
    const tokenHash = this.tokenProtection.hashAccessToken(userId, token);
    return { token: null, token_hash: tokenHash, token_enc: this.tokenProtection.sealAccessToken(userId, tokenHash, token) };
  }

  /** Rewrites a `token` condition into one on `token_hash`. */
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

  /** The query with `token` conditions on `token_hash` (top level and `$or`). */
  protectQuery (userId: string, query: Query): Query {
    if (query == null) return query;
    refuseIntegrityValueCondition(query);
    let out: Query | null = null;
    const copy = (): Query => { if (out == null) out = Object.assign({}, query); return out; };
    if ('token' in query) {
      const q = copy();
      q.token_hash = this.tokenCondition(userId, query.token);
      delete q.token;
    }
    if (Array.isArray(query.$or) && query.$or.some((c) => c != null && 'token' in c)) {
      copy().$or = (query.$or as Array<Record<string, unknown>>).map((clause) => {
        if (clause == null || !('token' in clause)) return clause;
        // The `$or` builder binds each value as a plain value: no operator here.
        if (clause.token != null && typeof clause.token === 'object') {
          throw new TypeError('accesses: a token condition inside $or takes a plain value');
        }
        const c: Record<string, unknown> = Object.assign({}, clause);
        c.token_hash = this.tokenCondition(userId, clause.token);
        delete c.token;
        return c;
      });
    }
    return out ?? query;
  }

  /**
   * A written `integrity` value as stored: every string is sealed, a
   * `sealed:`-looking one included (an item or update never carries a stored
   * form: such a value reads back as the same public string). Anything else
   * as given.
   */
  sealedIntegrity (userId: string, value: unknown): unknown {
    if (typeof value !== 'string') return value;
    return this.tokenProtection.sealAccessIntegrity(userId, value);
  }

  /**
   * The public `integrity` of a stored value: a clear one as stored (a row not
   * converted yet), a sealed one opened. A sealed value that does not open is
   * logged (ids only) and gives undefined: the item is returned without it.
   */
  openedIntegrity (userId: unknown, stored: unknown, accessId: unknown): unknown {
    if (!isSealedValue(stored)) return stored;
    try {
      if (typeof userId !== 'string') throw new Error('the row has no user id');
      return this.tokenProtection.openAccessIntegrity(userId, stored);
    } catch (err) {
      logUnreadableIntegrityOnce(userId, accessId, (err as Error).message);
      return undefined;
    }
  }

  /**
   * The update with a written token as its pair, an unset token as all three
   * columns unset, and a written `integrity` sealed.
   */
  protectUpdate (userId: string, update: Update): Update {
    if (update == null) return update;
    const plain = Object.prototype.hasOwnProperty.call(update, 'token');
    const inSet = update.$set != null && Object.prototype.hasOwnProperty.call(update.$set, 'token');
    const inUnset = update.$unset != null && Object.prototype.hasOwnProperty.call(update.$unset, 'token');
    const integrityPlain = typeof update.integrity === 'string';
    const integrityInSet = typeof update.$set?.integrity === 'string';
    for (const op of ['$inc', '$min', '$max'] as const) {
      const sub = (update as Record<string, unknown>)[op] as Record<string, unknown> | undefined;
      for (const key of ['token', 'integrity']) {
        if (sub != null && Object.prototype.hasOwnProperty.call(sub, key)) {
          throw new TypeError('accesses: ' + op + ' on ' + key + ' is not supported');
        }
      }
    }
    if (!plain && !inSet && !inUnset && !integrityPlain && !integrityInSet) return update;
    const out: Update = Object.assign({}, update);
    const $set: Record<string, unknown> = Object.assign({}, update.$set);
    const $unset: Record<string, unknown> = Object.assign({}, update.$unset);
    if (integrityPlain) out.integrity = this.sealedIntegrity(userId, out.integrity);
    if (integrityInSet) $set.integrity = this.sealedIntegrity(userId, $set.integrity);
    let token: unknown;
    let written = false;
    if (plain) { token = out.token; written = true; delete out.token; }
    if (inSet) { token = $set.token; written = true; delete $set.token; }
    if (inUnset) delete $unset.token;
    if (written && token != null) {
      if (typeof token !== 'string') throw new TypeError('accesses: token must be a string');
      Object.assign($set, this.protectedColumns(userId, token));
    } else if (written || inUnset) {
      Object.assign($unset, { token: 1, token_hash: 1, token_enc: 1 });
    }
    if (Object.keys($set).length > 0) out.$set = $set; else delete out.$set;
    if (Object.keys($unset).length > 0) out.$unset = $unset; else delete out.$unset;
    return out;
  }

  /** The item as stored: `token` replaced by its pair, `integrity` sealed (in place, key order kept). */
  toStorageItem (userId: string, item: AccessItem): AccessItem {
    if (item.token == null && typeof item.integrity !== 'string') return item;
    const pair = item.token != null ? this.protectedColumns(userId, item.token) : null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === 'token' && pair != null) Object.assign(out, pair);
      else if (k === 'integrity') out[k] = this.sealedIntegrity(userId, v);
      else out[k] = v;
    }
    return out as AccessItem;
  }

  buildWhere (userId: string, query: Query, startIdx: number = 1): { text: string, params: unknown[], nextIdx: number } {
    return super.buildWhere(userId, this.protectQuery(userId, query), startIdx);
  }

  buildSelect (options: Options): { select: string, excludeProps: string[] } {
    const projection = options?.projection;
    if (projection != null && projection.token && Object.values(projection).some((v) => v)) {
      const p: Record<string, unknown> = Object.assign({}, projection, { token_hash: 1, token_enc: 1 });
      return super.buildSelect(Object.assign({}, options, { projection: p }) as Options);
    }
    return super.buildSelect(options);
  }

  _findOneAndUpdateOn (queryable: PgDbLike, userOrUserId: UserOrId, query: Query, updatedData: Update, callback: Callback<AccessItem | null>): void {
    let update: Update;
    try {
      update = this.protectUpdate(this.getUserIdFromUserOrUserId(userOrUserId), updatedData);
    } catch (err) {
      return callback(err as Error);
    }
    super._findOneAndUpdateOn(queryable, userOrUserId, query, update, callback);
  }

  _updateManyOn (queryable: PgDbLike, userOrUserId: UserOrId, query: Query, updatedData: Update, callback: Callback<{ modifiedCount: number }>): void {
    let update: Update;
    try {
      update = this.protectUpdate(this.getUserIdFromUserOrUserId(userOrUserId), updatedData);
    } catch (err) {
      return callback(err as Error);
    }
    super._updateManyOn(queryable, userOrUserId, query, update, callback);
  }

  rowToItem (row: AccessRow): AccessItem | null {
    if (row == null) return null;
    if (isSealedValue(row.integrity)) {
      const r: AccessRow = Object.assign({}, row);
      const opened = this.openedIntegrity(r.user_id, r.integrity, r.id);
      if (opened === undefined) delete r.integrity; else r.integrity = opened;
      row = r;
    }
    if (row.token_enc != null || 'token_hash' in row || 'token_enc' in row) {
      const r: AccessRow = Object.assign({}, row);
      // A clear token (a row not converted yet) is authoritative over a pair.
      if (r.token == null && r.token_enc != null) {
        if (typeof r.token_hash !== 'string' || typeof r.user_id !== 'string') {
          throw tokenUnreadable(r.id, 'the row has an encrypted token without its hash');
        }
        try {
          r.token = this.tokenProtection.openAccessToken(r.user_id, r.token_hash, r.token_enc as string);
        } catch (err) {
          throw tokenUnreadable(r.id, (err as Error).message);
        }
      }
      delete r.token_hash;
      delete r.token_enc;
      row = r;
    }
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    // `headId` stays on the storage item: the integrity hash is computed on
    // the item's wire form (`composeWireAccess`, which uses `headId` for a
    // history row's id and then strips it), and the api-server layer strips
    // it the same way before responding to the client.
    return item;
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
  findDeletionRecords (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<Array<AccessItem | null>>): void {
    query = query || {};
    query.deleted = { $ne: null };
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this._findInternal(userId, query, options, callback);
  }

  /**
   * Marks the matching accesses deleted. A deleted access never authenticates
   * and its token is never returned: the deletion record drops it (token, hash
   * and encrypted copy), and so do the history rows of the deleted accesses,
   * in the same transaction (see `dropTokensOfDeletedRowsOn`). The integrity
   * of each is computed on the row without its token.
   */
  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number; integrityRecomputed?: number }>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const now = timestamp.now();

    const updateData: { $set: Record<string, unknown>; $unset: Record<string, unknown> } = {
      $set: { deleted: now },
      $unset: { integrity: 1, token: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      (this.db as PgDbWithTx).withTransaction(async (client: PgDbLike) => {
        const res = await new Promise<{ modifiedCount: number }>((resolve, reject) => {
          this._updateManyOn(client, userOrUserId, query, updateData,
            (err: Error | null, r?: { modifiedCount: number }) => err ? reject(err) : resolve(r!));
        });
        await this.dropTokensOfDeletedRowsOn(client, userId, now);
        return res;
      }).then((payload) => callback(null, payload), (err: Error) => callback(err));
      return;
    }

    const integrityBatchCode = Math.random();
    updateData.$set.integrityBatchCode = integrityBatchCode;

    const updateIfNeeded = (access: AccessItem): Update | null => {
      delete access.integrityBatchCode;
      const previousIntegrity = access.integrity;
      this.integrityAccesses.set(access, true);
      if (previousIntegrity === access.integrity) return null;
      return {
        $unset: { integrityBatchCode: 1 },
        $set: { integrity: access.integrity }
      };
    };

    // Batch-unset (statement 1) and the per-row recompute pass (statement 2)
    // run inside ONE transaction, both on the tx client, so a concurrent
    // integrity scan on another connection never sees a soft-deleted row while
    // its hash is transiently absent.
    (this.db as PgDbWithTx).withTransaction(async (client: PgDbLike) => {
      const res = await new Promise<{ modifiedCount: number }>((resolve, reject) => {
        this._updateManyOn(client, userOrUserId, query, updateData,
          (err: Error | null, r?: { modifiedCount: number }) => err ? reject(err) : resolve(r!));
      });
      const initialModifiedCount = res.modifiedCount;

      const res2 = await new Promise<{ count: number }>((resolve, reject) => {
        this._findAndUpdateIfNeededOn(client, userOrUserId, { integrityBatchCode }, {}, updateIfNeeded,
          (err2: Error | null, r2?: { count: number }) => err2 ? reject(err2) : resolve(r2!));
      });
      if (res2.count !== initialModifiedCount) {
        // Inside the transaction no concurrent writer can interleave between
        // the two passes, so a mismatch is a real bug signal, not race noise.
        logger.error('Issue when adding integrity to deleted accesses for ' +
          JSON.stringify(userId) + ' counts do not match');
      }
      await this.dropTokensOfDeletedRowsOn(client, userId, now);
      // Deliver the contract payload (delete count under `modifiedCount`,
      // like the non-integrity path and the SQLite twin) — not the raw
      // recompute result.
      return { modifiedCount: initialModifiedCount, integrityRecomputed: res2.count };
    }).then(
      (payload) => callback(null, payload),
      (err: Error) => callback(err)
    );
  }

  updateOne (userOrUserId: UserOrId, query: Query, update: Update & { modified?: number; integrity?: string; $set?: Record<string, unknown>; $unset?: Record<string, unknown> }, callback: Callback<AccessItem | null>): void {
    if (update.modified == null || !this.integrityAccesses.isActive) {
      return this.findOneAndUpdate(userOrUserId, query, update, callback);
    }

    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }

    // Statement 1 (apply fields + unset integrity) and statement 2 (recompute +
    // set integrity) run inside ONE transaction, both on the tx client, so a
    // concurrent integrity scan on another connection never observes the row
    // while its hash is transiently absent.
    (this.db as PgDbWithTx).withTransaction(async (client: PgDbLike) => {
      const accessData = await new Promise<AccessItem | null>((resolve, reject) => {
        this._findOneAndUpdateOn(client, userOrUserId, query, update,
          (err: Error | null, r?: AccessItem | null) => err ? reject(err) : resolve(r ?? null));
      });
      if (accessData?.id == null) return accessData ?? null;

      const integrityCheck = accessData.integrity;
      this.integrityAccesses.set(accessData, true);
      if (integrityCheck !== accessData.integrity) {
        return await new Promise<AccessItem | null>((resolve, reject) => {
          this._findOneAndUpdateOn(client, userOrUserId, { id: accessData.id },
            { integrity: accessData.integrity },
            (err: Error | null, r?: AccessItem | null) => err ? reject(err) : resolve(r ?? null));
        });
      }
      return accessData;
    }).then(
      (payload) => callback(null, payload),
      (err: Error) => callback(err)
    );
  }

  /**
   * Return the chronological history rows for a base id. Each row is
   * a frozen pre-update snapshot; `serial` is the value that row was
   * at before the update that produced the next version. Sorted by
   * `modified` ascending so caller iterates oldest-first.
   */
  async findHistory (userOrUserId: UserOrId, baseId: string): Promise<AccessItem[]> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const res = await this.db.query(
      'SELECT * FROM accesses WHERE user_id = $1 AND head_id = $2 ORDER BY modified ASC',
      [userId, baseId]
    );
    return res.rows.map((r: AccessRow) => this.rowToItem(r)).filter((x: AccessItem | null): x is AccessItem => x != null);
  }

  /**
   * Snapshot the current live head row into a history row. Reads the
   * head row as a camelCase item, clones it, replaces `id` with a
   * freshly-minted cuid and sets `headId` to the original base, drops
   * the head's integrity hash (so applyDefaults recomputes against the
   * snapshot row's fields), then routes through the standard insertOne
   * path. This keeps integrity consistent on the
   * history row.
   *
   * Caller is expected to mutate the head row immediately after this
   * call to bump `serial` (and update tracking + integrity).
   */
  snapshotHead (userOrUserId: UserOrId, baseId: string, callback: Callback<void>): void {
    const that = this;
    this.findOne(userOrUserId, { id: baseId }, null, function (err: Error | null, head?: AccessItem | null) {
      if (err) return callback(err);
      if (head == null) return callback(new Error('snapshotHead: no live head row for access id ' + JSON.stringify(baseId)));
      const snapshot: AccessItem = Object.assign({}, head);
      snapshot.id = generateId();
      snapshot.headId = baseId;
      delete snapshot.integrity;
      delete snapshot.apiEndpoint;
      that.insertOne(userOrUserId, snapshot, function (err2: Error | null) {
        callback(err2 || null);
      });
    });
  }

  /**
   * One-time upgrade pass: re-hash the rows whose stored form differs from
   * the wire form (updated accesses, their history rows and deletion
   * records) so their `integrity` verifies on what the API returns. A row is
   * rewritten only when its stored value is the hash of the row itself (the
   * previous computation): any other value is left for the integrity check
   * to report, never replaced. Idempotent: a second run rewrites nothing.
   * Each UPDATE is a compare-and-set on the stored value, so concurrent runs
   * (several cores booting on a shared database) and a run interrupted midway
   * are safe. Rows are read in batches (keyset on the primary key).
   */
  async recomputeIntegrityOfVersionedRows (): Promise<RecomputeResult> {
    const result: RecomputeResult = { scanned: 0, rewritten: 0, unverified: 0 };
    if (!this.integrityAccesses.isActive) return result;
    const rowForm = this.integrityAccesses.rowFormHash;
    if (typeof rowForm !== 'function') {
      // Without the previous hash a row cannot be checked before it is
      // rewritten: refuse rather than bless a value nobody verified.
      throw new Error('access integrity recompute needs integrityAccesses.rowFormHash');
    }
    let after: [string, string] | null = null;
    for (;;) {
      const res = await this.db.query(
        'SELECT * FROM accesses WHERE (head_id IS NOT NULL OR serial IS NOT NULL' +
        ' OR modified_by_serial IS NOT NULL OR created_by_serial IS NOT NULL)' +
        (after != null ? ' AND (user_id, id) > ($2, $3)' : '') +
        ' ORDER BY user_id, id LIMIT $1',
        after != null ? [RECOMPUTE_BATCH_SIZE, after[0], after[1]] : [RECOMPUTE_BATCH_SIZE]
      );
      for (const row of res.rows) {
        const item = this.rowToItem(row);
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
        // Compare-and-set on the stored (raw) value: clear before the
        // conversion, sealed after; the new value is written sealed.
        const upd = await this.db.query(
          'UPDATE accesses SET integrity = $1 WHERE user_id = $2 AND id = $3 AND integrity = $4',
          [this.sealedIntegrity(row.user_id as string, item.integrity), row.user_id, row.id, row.integrity]
        );
        result.rewritten += upd.rowCount;
      }
      if (res.rows.length < RECOMPUTE_BATCH_SIZE) break;
      const last = res.rows[res.rows.length - 1];
      after = [last.user_id as string, last.id as string];
    }
    logger.info('access integrity recompute: ' + result.scanned + ' versioned rows scanned, ' +
      result.rewritten + ' rewritten, ' + result.unverified + ' left as stored (not the previous row hash)');
    return result;
  }

  /**
   * Visit, in batches (keyset on the primary key), the rows matching `where`
   * (a condition on `accesses`, no parameter). `visit` returns the number of
   * rows it rewrote (0 or 1).
   */
  async _eachTokenRow (where: string, visit: (row: AccessRow) => Promise<number>): Promise<TokenPassResult> {
    const result: TokenPassResult = { rows: 0, skipped: 0 };
    let after: [string, string] | null = null;
    for (;;) {
      const res = await this.db.query(
        'SELECT user_id, id, token, token_hash, token_enc FROM accesses WHERE (' + where + ')' +
        (after != null ? ' AND (user_id, id) > ($2, $3)' : '') + ' ORDER BY user_id, id LIMIT $1',
        after != null ? [RECOMPUTE_BATCH_SIZE, after[0], after[1]] : [RECOMPUTE_BATCH_SIZE]
      );
      for (const row of res.rows) {
        const n = await visit(row);
        if (n > 0) result.rows += n; else result.skipped++;
      }
      if (res.rows.length < RECOMPUTE_BATCH_SIZE) break;
      const last = res.rows[res.rows.length - 1];
      after = [last.user_id as string, last.id as string];
    }
    return result;
  }

  /**
   * Protect every row still holding a clear token (live, deleted, history):
   * hash, seal and scrub in one compare-and-set statement per batch of rows
   * (on the clear value of each), so a crash leaves each row either old or
   * new and a re-run continues; a batch meeting a duplicate falls back to row
   * by row, the duplicate left in clear. The clear value
   * is authoritative: a hash already on such a row (written by a previous
   * image after a rollback) is replaced. Idempotent.
   */
  async protectClearRows (): Promise<TokenPassResult> {
    const result: TokenPassResult = { rows: 0, skipped: 0 };
    const batchSize = this.tokenBatchSize;
    let idleFirstRow: string | null = null;
    for (;;) {
      // Converted rows leave the selection: always the first batch.
      const res = await this.db.query(
        'SELECT user_id, id, token FROM accesses WHERE token IS NOT NULL ORDER BY user_id, id LIMIT $1', [batchSize]);
      if (res.rows.length === 0) break;
      const pairs = res.rows.map((row) => this.protectedColumns(row.user_id as string, row.token as string));
      try {
        // One statement per batch, compare-and-set on the clear value of each row.
        const upd = await this.db.query(
          'UPDATE accesses a SET token_hash = v.h, token_enc = v.e, token = NULL ' +
          'FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS v(uid, id, tok, h, e) ' +
          'WHERE a.user_id = v.uid AND a.id = v.id AND a.token = v.tok',
          [res.rows.map((r) => r.user_id), res.rows.map((r) => r.id), res.rows.map((r) => r.token),
            pairs.map((p) => p.token_hash), pairs.map((p) => p.token_enc)]);
        result.rows += upd.rowCount;
        if (upd.rowCount === 0) {
          // Nothing matched: another process (a second master on this
          // database) converted these rows meanwhile. Select again rather than
          // stop while rows remain in clear; the same first row selected twice
          // with no progress ends the pass.
          const first = JSON.stringify([res.rows[0].user_id, res.rows[0].id, res.rows[0].token]);
          if (first === idleFirstRow) break;
          idleFirstRow = first;
          continue;
        }
        idleFirstRow = null;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        // A duplicate in the batch: row by row, the duplicate left in clear.
        const one = await this._protectClearRowsOneByOne();
        result.rows += one.rows;
        result.skipped += one.skipped;
        break;
      }
      if (res.rows.length < batchSize) break;
    }
    if (result.rows > 0 || result.skipped > 0) {
      logger.info('access tokens at rest: ' + result.rows + ' access rows protected' +
        (result.skipped > 0 ? ', ' + result.skipped + ' left unconverted' : ''));
    }
    return result;
  }

  /** Row-by-row conversion: a row whose token another live access holds stays in clear. */
  async _protectClearRowsOneByOne (): Promise<TokenPassResult> {
    return await this._eachTokenRow('token IS NOT NULL', async (row) => {
      const cols = this.protectedColumns(row.user_id as string, row.token as string);
      try {
        const upd = await this.db.query(
          'UPDATE accesses SET token_hash = $1, token_enc = $2, token = NULL WHERE user_id = $3 AND id = $4 AND token = $5',
          [cols.token_hash, cols.token_enc, row.user_id, row.id, row.token]);
        return upd.rowCount;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        // Another live access of the user holds the same token (written by a
        // previous image after a rollback): left in clear, unusable for lookup.
        logger.error('access tokens at rest: access ' + JSON.stringify(row.id) + ' of user ' +
          JSON.stringify(row.user_id) + ' duplicates the token of another live access; left unconverted');
        return 0;
      }
    });
  }

  /** Whether any row still holds a clear token. */
  async hasClearRows (): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM accesses WHERE token IS NOT NULL LIMIT 1');
    return res.rows.length > 0;
  }

  /**
   * Whether any protected row is under another key than the configured one.
   * Run at every start: the smallest and the largest key-id prefix are read
   * from `idx_access_token_kid` (same expression for an 8-character key id),
   * not the whole table.
   */
  async hasForeignKeyRows (): Promise<boolean> {
    const n = keyIdPrefixLength(this.tokenProtection.kid);
    const res = await this.db.query(`SELECT min(left(token_hash, ${n})) AS lo, max(left(token_hash, ${n})) AS hi ` +
      'FROM accesses WHERE token IS NULL AND token_hash IS NOT NULL');
    return keyIdPrefixesForeign(res.rows[0], this.tokenProtection.kid);
  }

  async tokenStatus (): Promise<TokenStatus> {
    const res = await this.db.query(
      'SELECT CASE WHEN token IS NOT NULL THEN \'clear\' WHEN token_hash IS NULL THEN \'none\' ' +
      'ELSE left(token_hash, 8) END AS k, COUNT(*)::int AS n FROM accesses GROUP BY 1');
    const status: TokenStatus = { clear: 0, protectedCurrentKey: 0, protectedOtherKeys: {} };
    for (const r of res.rows) {
      if (r.k === 'clear') status.clear = r.n as number;
      else if (r.k === 'none') continue;
      else if (r.k === this.tokenProtection.kid) status.protectedCurrentKey = r.n as number;
      else status.protectedOtherKeys[r.k as string] = r.n as number;
    }
    return status;
  }

  /** Rows still holding a clear token (`user_id`, `id`), at most `limit`: after a pass, the ones it left. */
  async clearRowIds (limit: number): Promise<Array<{ userId: string; id: string }>> {
    const res = await this.db.query(
      'SELECT user_id, id FROM accesses WHERE token IS NOT NULL ORDER BY user_id, id LIMIT $1', [limit]);
    return res.rows.map((r) => ({ userId: r.user_id as string, id: r.id as string }));
  }

  /**
   * Rollback aid: write the clear token back and drop the pair, then restore
   * the clear-token unique index, so the image before token protection reads
   * the table. The clear value is authoritative: a row holding both a clear
   * token and a pair (a previous image wrote it after a rollback) only loses
   * its pair. Rows under another key cannot be opened: the run stops on the
   * first one (rekey first).
   */
  async unprotectRows (): Promise<TokenPassResult> {
    const result = await this._eachTokenRow('token IS NULL AND token_enc IS NOT NULL', async (row) => {
      const token = this.openRowToken(row);
      const upd = await this.db.query(
        'UPDATE accesses SET token = $1, token_hash = NULL, token_enc = NULL WHERE user_id = $2 AND id = $3 AND token IS NULL AND token_enc = $4',
        [token, row.user_id, row.id, row.token_enc]);
      return upd.rowCount;
    });
    // The stale pairs: the clear token stays, the pair goes.
    await this.db.query('UPDATE accesses SET token_hash = NULL, token_enc = NULL ' +
      'WHERE token IS NOT NULL AND (token_hash IS NOT NULL OR token_enc IS NOT NULL)');
    try {
      await this.db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_access_token ' +
        'ON accesses(user_id, token) WHERE deleted IS NULL AND head_id IS NULL');
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      throw new Error(await this.duplicateClearTokensMessage());
    }
    return result;
  }

  /** Names (ids only) the live accesses sharing a clear token, which block the clear-token index. */
  async duplicateClearTokensMessage (): Promise<string> {
    const res = await this.db.query(
      'SELECT user_id, array_agg(id ORDER BY id) AS ids FROM accesses WHERE token IS NOT NULL AND deleted IS NULL AND head_id IS NULL ' +
      'GROUP BY user_id, token HAVING COUNT(*) > 1 ORDER BY user_id LIMIT 20');
    const groups = res.rows.map((r) => 'user ' + JSON.stringify(r.user_id) + ': ' + (r.ids as string[]).map((id) => JSON.stringify(id)).join(', '));
    return 'access tokens at rest: the tokens were written back, but the clear-token unique index cannot be created: ' +
      'live accesses share a token (' + (groups.length > 0 ? groups.join('; ') : 'not found again') + '). ' +
      'Delete all but one access of each group, then run `node bin/access-tokens.js unprotect --yes` again.';
  }

  /**
   * Re-hash and re-seal under the configured key the rows protected under one
   * of `previous` (the key the rows carry is recognised by its kid). Rows under
   * a key not given are skipped and counted. Idempotent.
   */
  async rekeyRows (previous: TokenProtection[]): Promise<TokenPassResult> {
    return await this._eachTokenRow('token IS NULL AND token_enc IS NOT NULL', async (row) => {
      const hash = row.token_hash as string;
      if (this.tokenProtection.ownsHash(hash)) return 0;
      const from = previous.find((p) => p.ownsHash(hash));
      if (from == null) return 0;
      const token = from.openAccessToken(row.user_id as string, hash, row.token_enc as string);
      const cols = this.protectedColumns(row.user_id as string, token);
      try {
        const upd = await this.db.query(
          'UPDATE accesses SET token_hash = $1, token_enc = $2 WHERE user_id = $3 AND id = $4 AND token_hash = $5',
          [cols.token_hash, cols.token_enc, row.user_id, row.id, hash]);
        return upd.rowCount;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        // Another live access already holds this token under the configured
        // key (imported or created while the core refused to start).
        throw new Error('access tokens at rest: rekey stopped at access ' + JSON.stringify(row.id) + ' of user ' +
          JSON.stringify(row.user_id) + ': another live access of that user already holds the same token under the ' +
          'configured key. Delete one of the two accesses, then run rekey again (it is idempotent).');
      }
    });
  }

  /** The clear token of a protected row (throws the typed error). */
  openRowToken (row: AccessRow): string {
    try {
      return this.tokenProtection.openAccessToken(row.user_id as string, row.token_hash as string, row.token_enc as string);
    } catch (err) {
      throw tokenUnreadable(row.id, (err as Error).message);
    }
  }

  // ---- `integrity` at rest: sealed in the same column ----

  /**
   * Visit, in batches (keyset on the primary key), the rows matching `where`
   * (a condition on `accesses`, no parameter) with their raw `integrity`.
   */
  async _eachIntegrityRow (where: string, visit: (row: AccessRow) => Promise<number>): Promise<TokenPassResult> {
    const result: TokenPassResult = { rows: 0, skipped: 0 };
    let after: [string, string] | null = null;
    for (;;) {
      const res = await this.db.query(
        'SELECT user_id, id, integrity FROM accesses WHERE (' + where + ')' +
        (after != null ? ' AND (user_id, id) > ($2, $3)' : '') + ' ORDER BY user_id, id LIMIT $1',
        after != null ? [RECOMPUTE_BATCH_SIZE, after[0], after[1]] : [RECOMPUTE_BATCH_SIZE]
      );
      for (const row of res.rows) {
        const n = await visit(row);
        if (n > 0) result.rows += n; else result.skipped++;
      }
      if (res.rows.length < RECOMPUTE_BATCH_SIZE) break;
      const last = res.rows[res.rows.length - 1];
      after = [last.user_id as string, last.id as string];
    }
    return result;
  }

  /**
   * Seal every `integrity` still stored in clear (live, deleted, history
   * rows; also those written while integrity was active and kept since). One
   * compare-and-set statement per batch on the clear value of each row, so a
   * crash leaves each row either old or new and a re-run continues. Batches
   * follow the primary key (keyset), so no batch reads the rows already
   * sealed, index or not; a row another process sealed or changed meanwhile
   * is skipped (the next start sees it if it is still clear). Idempotent.
   */
  async sealClearIntegrityRows (): Promise<TokenPassResult> {
    const result: TokenPassResult = { rows: 0, skipped: 0 };
    const batchSize = this.tokenBatchSize;
    let after: [string, string] | null = null;
    for (;;) {
      const res: { rows: AccessRow[] } = await this.db.query(
        'SELECT user_id, id, integrity FROM accesses WHERE ' + CLEAR_INTEGRITY_WHERE +
        (after != null ? ' AND (user_id, id) > ($2, $3)' : '') + ' ORDER BY user_id, id LIMIT $1',
        after != null ? [batchSize, after[0], after[1]] : [batchSize]);
      if (res.rows.length === 0) break;
      const sealed = res.rows.map((row) => this.tokenProtection.sealAccessIntegrity(row.user_id as string, row.integrity as string));
      const upd = await this.db.query(
        'UPDATE accesses a SET integrity = v.s ' +
        'FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(uid, id, clr, s) ' +
        'WHERE a.user_id = v.uid AND a.id = v.id AND a.integrity = v.clr',
        [res.rows.map((r) => r.user_id), res.rows.map((r) => r.id), res.rows.map((r) => r.integrity), sealed]);
      result.rows += upd.rowCount;
      result.skipped += res.rows.length - upd.rowCount;
      if (res.rows.length < batchSize) break;
      const last = res.rows[res.rows.length - 1];
      after = [last.user_id as string, last.id as string];
    }
    if (result.rows > 0) logger.info('access integrity at rest: ' + result.rows + ' access rows sealed');
    return result;
  }

  /** Whether any row still stores its `integrity` in clear (reads `idx_access_integrity_clear`). */
  async hasClearIntegrityRows (): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM accesses WHERE ' + CLEAR_INTEGRITY_WHERE + ' LIMIT 1');
    return res.rows.length > 0;
  }

  /**
   * Whether any sealed `integrity` is under another key than the configured
   * one: the smallest and the largest `sealed:<kid>.` prefix, read from
   * `idx_access_integrity_kid` (same expression for an 8-character key id).
   */
  async hasForeignKeyIntegrityRows (): Promise<boolean> {
    const kid = this.tokenProtection.kid;
    const n = sealedPrefixLength(kid);
    const res = await this.db.query(`SELECT min(left(integrity, ${n})) AS lo, max(left(integrity, ${n})) AS hi ` +
      'FROM accesses WHERE ' + SEALED_INTEGRITY_WHERE);
    const bounds = res.rows[0];
    if (bounds == null || bounds.lo == null) return false;
    const own = SEALED_PREFIX + kid + '.';
    return bounds.lo !== own || bounds.hi !== own;
  }

  async integrityStatus (): Promise<IntegrityStatus> {
    const res = await this.db.query(
      'SELECT CASE WHEN integrity IS NULL THEN \'none\' WHEN integrity NOT LIKE \'sealed:%\' THEN \'clear\' ' +
      `ELSE substr(integrity, ${SEALED_PREFIX.length + 1}, 8) END AS k, COUNT(*)::int AS n FROM accesses GROUP BY 1`);
    const status: IntegrityStatus = { clear: 0, sealedCurrentKey: 0, sealedOtherKeys: {} };
    for (const r of res.rows) {
      if (r.k === 'none') continue;
      if (r.k === 'clear') status.clear = r.n as number;
      else if (r.k === this.tokenProtection.kid) status.sealedCurrentKey = r.n as number;
      else status.sealedOtherKeys[r.k as string] = r.n as number;
    }
    return status;
  }

  /**
   * Rollback aid: write the public `integrity` value back in clear (what the
   * image before sealing reads). A value under another key stops the run
   * (rekey first, the guard refuses it before); one that does not open under
   * the configured key is left as stored and logged.
   */
  async unsealIntegrityRows (): Promise<TokenPassResult> {
    return await this._eachIntegrityRow(SEALED_INTEGRITY_WHERE, async (row) => {
      let clear: string;
      try {
        clear = this.tokenProtection.openAccessIntegrity(row.user_id as string, row.integrity as string);
      } catch (err) {
        logger.error('access integrity at rest: access ' + JSON.stringify(row.id) + ' of user ' +
          JSON.stringify(row.user_id) + ': integrity unreadable, left sealed (' + (err as Error).message + ')');
        return 0;
      }
      const upd = await this.db.query('UPDATE accesses SET integrity = $1 WHERE user_id = $2 AND id = $3 AND integrity = $4',
        [clear, row.user_id, row.id, row.integrity]);
      return upd.rowCount;
    });
  }

  /**
   * Re-seal under the configured key the `integrity` values sealed under one
   * of `previous`. A value that does not open under its previous key does not
   * stop the run: it is logged (ids only), left as is and listed in
   * `unreadable`, so the rest is re-keyed (the guard then names the remedy).
   */
  async rekeyIntegrityRows (previous: TokenProtection[]): Promise<TokenPassResult & { unreadable: Array<{ userId: string; id: string }> }> {
    const unreadable: Array<{ userId: string; id: string }> = [];
    const res = await this._eachIntegrityRow(SEALED_INTEGRITY_WHERE, async (row) => {
      const stored = row.integrity as string;
      if (this.tokenProtection.ownsSealed(stored)) return 0;
      const from = previous.find((p) => p.ownsSealed(stored));
      if (from == null) return 0;
      let clear: string;
      try {
        clear = from.openAccessIntegrity(row.user_id as string, stored);
      } catch (err) {
        logger.error('access integrity at rest: rekey: access ' + JSON.stringify(row.id) + ' of user ' + JSON.stringify(row.user_id) +
          ': integrity does not open under its previous key, left as is (' + (err as Error).message + ')');
        unreadable.push({ userId: row.user_id as string, id: row.id as string });
        return 0;
      }
      const upd = await this.db.query('UPDATE accesses SET integrity = $1 WHERE user_id = $2 AND id = $3 AND integrity = $4',
        [this.tokenProtection.sealAccessIntegrity(row.user_id as string, clear), row.user_id, row.id, stored]);
      return upd.rowCount;
    });
    return Object.assign(res, { unreadable });
  }

  // ---- Tokens of deleted accesses ----

  /**
   * Drop the token (clear, hash and encrypted copy) of every deleted row, and
   * of every history row whose head is deleted, of `userId` (all users when
   * null): a deleted access never authenticates and its token is never
   * returned. `modified` is untouched (history rows stay frozen otherwise).
   * While integrity is active, a row whose stored integrity verifies on the
   * row with its token is re-hashed without it; any other value is kept as
   * stored, for the integrity check to report. One compare-and-set statement
   * per row, on its raw token columns and integrity. Idempotent.
   *
   * `deletedAt` (a deletion, with `userId`): only the history rows of the
   * heads that deletion marked (`deleted = deletedAt`; the heads themselves
   * lost their token in its update), read through `idx_access_head_id`, not
   * every history row of the account.
   */
  async dropTokensOfDeletedRowsOn (queryable: PgDbLike, userId: string | null, deletedAt?: number): Promise<number> {
    const holdsToken = '(a.token IS NOT NULL OR a.token_hash IS NOT NULL OR a.token_enc IS NOT NULL)';
    let count = 0;
    let after: [string, string] | null = null;
    for (;;) {
      const params: unknown[] = [];
      let sql = 'SELECT a.* FROM accesses a WHERE ' + holdsToken;
      if (userId != null) { params.push(userId); sql += ' AND a.user_id = $' + params.length; }
      if (userId != null && deletedAt != null) {
        params.push(deletedAt);
        sql += ' AND a.head_id IN (SELECT d.id FROM accesses d WHERE d.user_id = $1 AND d.deleted = $' + params.length + ' AND d.head_id IS NULL)';
      } else {
        sql += ' AND (a.deleted IS NOT NULL OR (a.head_id IS NOT NULL AND EXISTS (SELECT 1 FROM accesses d ' +
          'WHERE d.user_id = a.user_id AND d.id = a.head_id AND d.deleted IS NOT NULL)))';
      }
      if (after != null) { params.push(after[0], after[1]); sql += ' AND (a.user_id, a.id) > ($' + (params.length - 1) + ', $' + params.length + ')'; }
      params.push(RECOMPUTE_BATCH_SIZE);
      sql += ' ORDER BY a.user_id, a.id LIMIT $' + params.length;
      const res = await queryable.query(sql, params);
      for (const row of res.rows) count += await this._dropTokenOfRow(queryable, row);
      if (res.rows.length < RECOMPUTE_BATCH_SIZE) break;
      const last = res.rows[res.rows.length - 1];
      after = [last.user_id as string, last.id as string];
    }
    if (count > 0) logger.info('access tokens at rest: token dropped from ' + count + ' deleted access rows' + (userId != null ? ' of user ' + userId : ''));
    return count;
  }

  /** Every user: see `dropTokensOfDeletedRowsOn`. */
  async dropTokensOfDeletedRows (): Promise<number> {
    return await this.dropTokensOfDeletedRowsOn(this.db, null);
  }

  async _dropTokenOfRow (queryable: PgDbLike, row: AccessRow): Promise<number> {
    let integrity: unknown = row.integrity;
    if (this.integrityAccesses.isActive && row.integrity != null) {
      const without = this.rowToItem(Object.assign({}, row, { token: null, token_hash: null, token_enc: null }));
      let verifies = false;
      try {
        const withToken = this.rowToItem(row);
        if (withToken?.integrity != null) {
          const check = Object.assign({}, withToken);
          this.integrityAccesses.set(check, true);
          verifies = check.integrity === withToken.integrity;
        }
      } catch (_e) {
        // the token does not open: the stored integrity cannot be verified, kept as stored
      }
      if (verifies && without != null) {
        this.integrityAccesses.set(without, true);
        integrity = this.sealedIntegrity(row.user_id as string, without.integrity);
      }
    }
    const upd = await queryable.query(
      'UPDATE accesses SET token = NULL, token_hash = NULL, token_enc = NULL, integrity = $1 ' +
      'WHERE user_id = $2 AND id = $3 AND token IS NOT DISTINCT FROM $4 AND token_hash IS NOT DISTINCT FROM $5 ' +
      'AND token_enc IS NOT DISTINCT FROM $6 AND integrity IS NOT DISTINCT FROM $7',
      [integrity, row.user_id, row.id, row.token, row.token_hash, row.token_enc, row.integrity]);
    return upd.rowCount;
  }

  /**
   * With `options.onUnreadableRow` (a whole-store read made for a report, the
   * integrity check), a row whose token does not open is reported there and
   * left out instead of failing the read. Without it the read throws, as every
   * lookup does.
   */
  exportAll (userOrUserId: UserOrId, callback: Callback<Array<AccessItem | null>>, options?: ExportAccessesOptions): void {
    const report = options?.onUnreadableRow;
    if (report == null) return super.exportAll(userOrUserId, callback);
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this.db.query('SELECT * FROM accesses WHERE user_id = $1', [userId])
      .then((res: { rows: AccessRow[] }) => callback(null, itemsReportingUnreadable(res.rows, (r) => this.rowToItem(r), report)))
      .catch(callback);
  }

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    const accessesToCreate = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, accessesToCreate, callback);
  }

  /**
   * A restore: a backup taken before deleted accesses dropped their token
   * still carries it on deletion records and their history rows; it goes
   * after the import, as at deletion.
   */
  importAll (userOrUserId: UserOrId, items: AccessItem[], callback: Callback<void>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    super.importAll(userOrUserId, items, (err: Error | null) => {
      if (err) return callback(err);
      this.dropTokensOfDeletedRowsOn(this.db, userId).then(() => callback(null), (err2: Error) => callback(err2));
    });
  }
}

export { AccessesPG };
