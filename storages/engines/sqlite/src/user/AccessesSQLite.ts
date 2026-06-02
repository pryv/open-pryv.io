/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId } from '../../../../interfaces/_shared/types.ts';
const require = createRequire(import.meta.url);

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

type IntegrityAccesses = { isActive: boolean; set: (access: AccessRow, recompute?: boolean) => void };
type AccessRow = { id: string; token?: string; name?: string; type?: string; deviceName?: string | null; deleted?: number | null; headId?: string | null; integrity?: string | null; integrityBatchCode?: number; [k: string]: unknown };
type AccessUpdate = { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; modified?: number; integrity?: string | null; [k: string]: unknown };

class AccessesSQLite extends BaseStorageSQLite {
  integrityAccesses: IntegrityAccesses;

  constructor (integrityAccesses?: IntegrityAccesses) {
    super();
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = true;
    this.defaultSort = `json_extract(data, '$.name') ASC`;
    this.integrityAccesses = integrityAccesses || { isActive: false, set: () => {} };
  }

  rowToItem (row: Record<string, unknown>): AccessRow | null {
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    return item;
  }

  applyDefaults (item: Partial<AccessRow>): AccessRow {
    const copy = Object.assign({}, item) as AccessRow;
    copy.id = copy.id || generateId();
    copy.token = copy.token || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    delete copy.apiEndpoint;
    if (this.integrityAccesses.isActive) {
      this.integrityAccesses.set(copy);
    }
    return copy;
  }

  generateToken (): string {
    return generateId();
  }

  findDeletions (userOrUserId: UserOrId, query: Record<string, unknown>, options: unknown, callback: Callback<AccessRow[]>): void {
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

    this.updateMany(userOrUserId, query, updateData, (err: Error | null, res: { modifiedCount: number }) => {
      if (err) return callback(err);
      const initial = res.modifiedCount;
      const updateIfNeeded = (access: AccessRow): AccessUpdate | null => {
        delete access.integrityBatchCode;
        const prev = access.integrity;
        this.integrityAccesses.set(access, true);
        if (prev === access.integrity) return null;
        return {
          $unset: { integrityBatchCode: 1 },
          $set: { integrity: access.integrity }
        };
      };
      this.findAndUpdateIfNeeded(userOrUserId, { integrityBatchCode }, {}, updateIfNeeded, (err2: Error | null, res2?: { count?: number }) => {
        if (err2) return callback(err2);
        callback(null, { modifiedCount: initial, integrityRecomputed: res2?.count ?? 0 });
      });
    });
  }

  updateOne (userOrUserId: UserOrId, query: Record<string, unknown>, update: AccessUpdate, callback: Callback<AccessRow>): void {
    if (update.modified == null || !this.integrityAccesses.isActive) {
      return this.findOneAndUpdate(userOrUserId, query, update, callback);
    }
    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }
    this.findOneAndUpdate(userOrUserId, query, update, (err: Error | null, accessData: AccessRow | null) => {
      if (err || accessData?.id == null) return callback(err, accessData ?? undefined);
      const before = accessData.integrity;
      try {
        this.integrityAccesses.set(accessData, true);
      } catch (eInt) {
        return callback(eInt as Error | null, accessData);
      }
      if (before !== accessData.integrity) {
        return this.findOneAndUpdate(userOrUserId, { id: accessData.id },
          { integrity: accessData.integrity }, callback);
      }
      callback(err, accessData);
    });
  }

  async findHistory (userOrUserId: UserOrId, baseId: string): Promise<any[]> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
    const rows = udb.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE head_id = ? ORDER BY json_extract(data, '$.modified') ASC`
    ).all(baseId);
    return rows.map((r: Record<string, unknown>) => this.rowToItem(r)).filter((x: AccessRow | null) => x != null);
  }

  snapshotHead (userOrUserId: UserOrId, baseId: string, callback: Callback<void>): void {
    this.findOne(userOrUserId, { id: baseId }, null, (err: Error | null, head: AccessRow | null) => {
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

  insertMany (userOrUserId: UserOrId, accesses: Array<Partial<AccessRow>>, callback: Callback<void>): void {
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
  insertOne (userOrUserId: UserOrId, item: Partial<AccessRow>, callback: Callback<AccessRow>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(Object.assign({ deleted: null }, item));
    // Versioned snapshots (headId != null) bypass the uniqueness check —
    // PG's `idx_access_token` predicate is `WHERE deleted IS NULL AND
    // head_id IS NULL`, so multiple snapshots sharing token/name with a
    // live head are allowed there too.
    if (prepared.headId != null) {
      return super.insertOne(userId, prepared, callback);
    }
    this.findIncludingDeletionsAndVersions(userId, { deleted: null, headId: null }, null, (err: Error | null, existing: AccessRow[]) => {
      if (err) return callback(err);
      for (const ex of (existing || [])) {
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

export { AccessesSQLite };
