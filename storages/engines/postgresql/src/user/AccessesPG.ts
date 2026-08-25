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

const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG.ts') as typeof import('./BaseStoragePG.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const { _internals } = require('../_internals.ts');
const timestamp = require('unix-timestamp');

const logger = _internals.lazyLogger('storage:accesses-pg');

type IntegrityAccesses = { isActive: boolean; set: (item: AccessItem, deep?: boolean) => void };
/** Storage item for this collection — the canonical stored shape. */
type AccessItem = StoredAccess;
type AccessRow = Record<string, unknown>;
type Update = UpdateData;
type Options = FindOptions;
/** `this.db` is a `DatabasePG` at runtime; the base only types the query slice
 *  it needs (`PgDbLike`). The integrity-preserving update/delete run their two
 *  statements inside `withTransaction` so no other connection can observe the
 *  hash-less intermediate row (the B-2026-08-25-1 window). */
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

/**
 * PostgreSQL persistence for accesses.
 */
class AccessesPG extends BaseStoragePG<AccessItem> {
  integrityAccesses: IntegrityAccesses;

  constructor (db: PgDbLike, integrityAccesses: IntegrityAccesses) {
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
    this.integrityAccesses = integrityAccesses;
  }

  rowToItem (row: AccessRow): AccessItem | null {
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    // `headId` stays on the storage item so the integrity hash
    // (computed at insert time including headId) round-trips
    // consistently with the read-time recompute. The api-server layer
    // strips `headId` via `composeWireAccess` before responding to
    // the client.
    return item;
  }

  applyDefaults (item: Partial<AccessItem>): AccessItem {
    const copy = Object.assign({}, item) as AccessItem;
    copy.id = copy.id || generateId();
    copy.token = copy.token || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    delete copy.apiEndpoint;
    if (this.integrityAccesses.isActive) {
      this.integrityAccesses.set(copy);
      assertIntegritySet(copy);
    }
    return copy;
  }

  generateToken (): string {
    return generateId();
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
    // its hash is transiently absent (B-2026-08-25-1).
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
    // while its hash is transiently absent (B-2026-08-25-1).
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

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    const accessesToCreate = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, accessesToCreate, callback);
  }
}

export { AccessesPG };