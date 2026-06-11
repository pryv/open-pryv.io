/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * UserStorage — common contract for all user-scoped BaseStorage subclasses
 * (Accesses, Profile, Streams, Webhooks).
 *
 * These are constructor/prototype-based classes, so we use the **validate**
 * pattern: check that all required methods exist on the instance's prototype chain.
 */

import type { Callback, UserOrId, StoredItem, Query, UpdateData, FindOptions } from '../_shared/types.ts';

export interface CollectionInfo {
  name: string | null;
  useUserId: string;
}

/**
 * Generic over the stored item shape: collections bind `T` (e.g.
 * `UserStorage<StoredAccess>`); engine bases implement against the default
 * `StoredItem`. Find-family results carry `T | null` because projections
 * and deletion records can reduce rows to partial documents.
 */
export interface UserStorage<T extends StoredItem = StoredItem> {
  getCollectionInfo (userOrUserId: UserOrId): CollectionInfo;

  find (userOrUserId: UserOrId, query: Query, options: FindOptions, callback: Callback<Array<T | null>>): void;
  findOne (userOrUserId: UserOrId, query: Query, options: FindOptions, callback: Callback<T | null>): void;
  insertOne (userOrUserId: UserOrId, item: T, callback: Callback<T | null>): void;
  findOneAndUpdate (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<T | null>): void;
  updateOne (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<T | null>): void;
  updateMany (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<{ modifiedCount: number }>): void;

  /** Soft-delete (stamps `deleted`); counts like updateMany. */
  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number }>): void;
  removeOne (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void;
  removeMany (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void;
  removeAll (userOrUserId: UserOrId, callback: Callback<number>): void;

  count (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void;
  countAll (userOrUserId: UserOrId, callback: Callback<number>): void;

  findDeletions (userOrUserId: UserOrId, deletedSince: number, options: FindOptions, callback: Callback<Array<T | null>>): void;

  // Cross-user iteration (per-user DBs on SQLite, shared tables on PG)
  iterateAll (): AsyncGenerator<T | null>;

  // Migration methods — operate directly on the database, bypassing converters
  exportAll (userOrUserId: UserOrId, callback: Callback<Array<T | null>>): void;
  importAll (userOrUserId: UserOrId, data: T[], callback: Callback<void>): void;
  clearAll (userOrUserId: UserOrId, callback: Callback<number>): void;
}

const REQUIRED_METHODS: string[] = [
  'getCollectionInfo',
  'find',
  'findOne',
  'insertOne',
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
  'delete',
  'removeOne',
  'removeMany',
  'removeAll',
  'count',
  'countAll',
  'findDeletions',
  // Cross-user iteration
  'iterateAll',
  // Migration methods
  'exportAll',
  'importAll',
  'clearAll'
];

function validateUserStorage (instance: unknown): UserStorage {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`UserStorage implementation missing method: ${method}`);
    }
  }
  return obj as unknown as UserStorage;
}

export { validateUserStorage, REQUIRED_METHODS };