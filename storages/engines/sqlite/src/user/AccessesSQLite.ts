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
const require = createRequire(import.meta.url);

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts') as typeof import('./BaseStorageSQLite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

type IntegrityAccesses = { isActive: boolean; set: (access: AccessItem, recompute?: boolean) => void };
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

class AccessesSQLite extends BaseStorageSQLite<AccessItem> {
  integrityAccesses: IntegrityAccesses;

  constructor (integrityAccesses: IntegrityAccesses) {
    super();
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = true;
    this.defaultSort = `json_extract(data, '$.name') ASC`;
    if (integrityAccesses == null) {
      throw new Error(
        'AccessesSQLite requires an integrityAccesses ref — pass ' +
        '{ isActive: false, set: () => {} } explicitly for integrity-less contexts'
      );
    }
    this.integrityAccesses = integrityAccesses;
  }

  rowToItem (row: DbRow): AccessItem | null {
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
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
  findDeletionRecords (userOrUserId: UserOrId, query: Record<string, unknown>, options: FindOptions, callback: Callback<Array<AccessItem | null>>): void {
    const q = Object.assign({}, query || {}, { deleted: { $ne: null } });
    this.findIncludingDeletionsAndVersions(userOrUserId, q, options, callback);
  }

  delete (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<{ modifiedCount: number; integrityRecomputed?: number }>): void {
    const now = timestamp.now();
    const updateData: AccessUpdate = {
      $set: { deleted: now },
      $unset: { integrity: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      return this.updateMany(userOrUserId, query, updateData, callback);
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
    // never sees a soft-deleted row while its hash is transiently absent
    // (B-2026-08-25-1). The tx body must be synchronous — hence the *Sync cores.
    this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
      const res = this._updateManySync(udb, query, updateData);
      const res2 = this._findAndUpdateIfNeededSync(udb, { integrityBatchCode }, {}, updateIfNeeded);
      return { modifiedCount: res.modifiedCount, integrityRecomputed: res2.count };
    })());
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
    // absent (B-2026-08-25-1). The tx body must be synchronous.
    this._userDbAndWrite(userOrUserId, callback, (udb) => udb.db.transaction(() => {
      const accessData = this._findOneAndUpdateSync(udb, query, update);
      if (accessData?.id == null) return accessData ?? null;
      const before = accessData.integrity;
      this.integrityAccesses.set(accessData, true);
      if (before !== accessData.integrity) {
        return this._findOneAndUpdateSync(udb, { id: accessData.id }, { integrity: accessData.integrity });
      }
      return accessData;
    })());
  }

  async findHistory (userOrUserId: UserOrId, baseId: string): Promise<AccessItem[]> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
    const rows = udb.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE head_id = ? ORDER BY json_extract(data, '$.modified') ASC`
    ).all(baseId);
    return rows.map((r: DbRow) => this.rowToItem(r)).filter((x: AccessItem | null): x is AccessItem => x != null);
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

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessItem>>, callback: Callback<void>): void {
    const prepared = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, prepared, callback);
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
    this.findIncludingDeletionsAndVersions(userId, { deleted: null, headId: null }, null, (err: Error | null, existing?: Array<AccessItem | null>) => {
      if (err) return callback(err);
      for (const ex of (existing || [])) {
        if (ex == null) continue;
        if (ex.id === prepared.id) continue; // same row (shouldn't happen — defensive)
        if (ex.token != null && ex.token === prepared.token) {
          return callback(duplicateIndexError(['token'], { token: '(hidden)' }));
        }
        if (ex.name != null && ex.type != null &&
            ex.name === prepared.name &&
            ex.type === prepared.type &&
            (ex.deviceName ?? null) === (prepared.deviceName ?? null)) {
          return callback(duplicateIndexError(['name', 'type', 'deviceName'], {
            name: prepared.name, type: prepared.type, deviceName: prepared.deviceName ?? null
          }));
        }
      }
      super.insertOne(userId, prepared, callback);
    });
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

export { AccessesSQLite, duplicateIndexError };
