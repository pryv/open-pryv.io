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
import type { TokenProtection } from '../../../../interfaces/_shared/tokenProtection.ts';

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

/**
 * PostgreSQL persistence for accesses.
 */
class AccessesPG extends BaseStoragePG<AccessItem> {
  integrityAccesses: IntegrityAccesses;

  tokenProtection: TokenProtection;

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
        const c: Record<string, unknown> = Object.assign({}, clause);
        c.token_hash = this.tokenCondition(userId, clause.token);
        delete c.token;
        return c;
      });
    }
    return out ?? query;
  }

  /** The update with a written token as its pair, an unset token as all three columns unset. */
  protectUpdate (userId: string, update: Update): Update {
    if (update == null) return update;
    const plain = Object.prototype.hasOwnProperty.call(update, 'token');
    const inSet = update.$set != null && Object.prototype.hasOwnProperty.call(update.$set, 'token');
    const inUnset = update.$unset != null && Object.prototype.hasOwnProperty.call(update.$unset, 'token');
    for (const op of ['$inc', '$min', '$max'] as const) {
      const sub = (update as Record<string, unknown>)[op] as Record<string, unknown> | undefined;
      if (sub != null && Object.prototype.hasOwnProperty.call(sub, 'token')) {
        throw new TypeError('accesses: ' + op + ' on token is not supported');
      }
    }
    if (!plain && !inSet && !inUnset) return update;
    const out: Update = Object.assign({}, update);
    const $set: Record<string, unknown> = Object.assign({}, update.$set);
    const $unset: Record<string, unknown> = Object.assign({}, update.$unset);
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

  /** The item as stored: `token` replaced by its pair (in place, key order kept). */
  toStorageItem (userId: string, item: AccessItem): AccessItem {
    if (item.token == null) return item;
    const pair = this.protectedColumns(userId, item.token);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === 'token') Object.assign(out, pair);
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
    copy.token = copy.token || secureToken();
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

  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number; integrityRecomputed?: number }>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const now = timestamp.now();

    const updateData: { $set: Record<string, unknown>; $unset: Record<string, unknown> } = {
      $set: { deleted: now },
      $unset: { integrity: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      return this.updateMany(userOrUserId, query, updateData, callback);
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
        const upd = await this.db.query(
          'UPDATE accesses SET integrity = $1 WHERE user_id = $2 AND id = $3 AND integrity = $4',
          [item.integrity, row.user_id, row.id, stored]
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
    for (;;) {
      // Converted rows leave the selection: always the first batch.
      const res = await this.db.query(
        'SELECT user_id, id, token FROM accesses WHERE token IS NOT NULL ORDER BY user_id, id LIMIT $1', [RECOMPUTE_BATCH_SIZE]);
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
        // Nothing matched (rows changed meanwhile): no progress to expect here.
        if (upd.rowCount === 0) break;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        // A duplicate in the batch: row by row, the duplicate left in clear.
        const one = await this._protectClearRowsOneByOne();
        result.rows += one.rows;
        result.skipped += one.skipped;
        break;
      }
      if (res.rows.length < RECOMPUTE_BATCH_SIZE) break;
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

  /** Whether any protected row is under another key than the configured one. */
  async hasForeignKeyRows (): Promise<boolean> {
    const res = await this.db.query(
      'SELECT 1 FROM accesses WHERE token IS NULL AND token_hash IS NOT NULL AND token_hash NOT LIKE $1 LIMIT 1',
      [this.tokenProtection.kid + '.%']);
    return res.rows.length > 0;
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

  /**
   * Rollback aid: write the clear token back and drop the pair, then restore
   * the clear-token unique index, so the image before token protection reads
   * the table. Rows under another key cannot be opened: the run stops on the
   * first one (rekey first).
   */
  async unprotectRows (): Promise<TokenPassResult> {
    const result = await this._eachTokenRow('token_enc IS NOT NULL', async (row) => {
      const token = this.openRowToken(row);
      const upd = await this.db.query(
        'UPDATE accesses SET token = $1, token_hash = NULL, token_enc = NULL WHERE user_id = $2 AND id = $3 AND token_enc = $4',
        [token, row.user_id, row.id, row.token_enc]);
      return upd.rowCount;
    });
    await this.db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_access_token ' +
      'ON accesses(user_id, token) WHERE deleted IS NULL AND head_id IS NULL');
    return result;
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
      const upd = await this.db.query(
        'UPDATE accesses SET token_hash = $1, token_enc = $2 WHERE user_id = $3 AND id = $4 AND token_hash = $5',
        [cols.token_hash, cols.token_enc, row.user_id, row.id, hash]);
      return upd.rowCount;
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

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    const accessesToCreate = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, accessesToCreate, callback);
  }
}

export { AccessesPG };
