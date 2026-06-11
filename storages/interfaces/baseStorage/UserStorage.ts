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

import type { Callback, UserOrId } from '../_shared/types.ts';

export interface CollectionInfo {
  name: string;
  indexes: Array<{ index: Record<string, number>, options?: Record<string, unknown> }>;
  useUserId: string;
}

export interface UserStorage {
  getCollectionInfo (userOrUserId: UserOrId): CollectionInfo;

  find (userOrUserId: UserOrId, query: Record<string, unknown>, options: Record<string, unknown> | null, callback: Callback<unknown[]>): void;
  findOne (userOrUserId: UserOrId, query: Record<string, unknown>, options: Record<string, unknown> | null, callback: Callback<unknown>): void;
  insertOne (userOrUserId: UserOrId, item: Record<string, unknown>, callback: Callback<unknown>, options?: Record<string, unknown>): void;
  findOneAndUpdate (userOrUserId: UserOrId, query: Record<string, unknown>, updatedData: Record<string, unknown>, callback: Callback<unknown>): void;
  updateOne (userOrUserId: UserOrId, query: Record<string, unknown>, updatedData: Record<string, unknown>, callback: Callback<unknown>): void;
  updateMany (userOrUserId: UserOrId, query: Record<string, unknown>, updatedData: Record<string, unknown>, callback: Callback<unknown>): void;

  delete (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<unknown>): void;
  removeOne (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<unknown>): void;
  removeMany (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<unknown>): void;
  removeAll (userOrUserId: UserOrId, callback: Callback<unknown>): void;

  count (userOrUserId: UserOrId, query: Record<string, unknown>, callback: Callback<number>): void;
  countAll (userOrUserId: UserOrId, callback: Callback<number>): void;

  findDeletions (userOrUserId: UserOrId, deletedSince: number, options: Record<string, unknown> | null, callback: Callback<unknown[]>): void;

  // Cross-user iteration
  iterateAll (callback: (item: unknown, done: () => void) => void, doneCallback: Callback<unknown>): void;

  // Migration methods — operate directly on the database, bypassing converters
  exportAll (userOrUserId: UserOrId, callback: Callback<unknown[]>): void;
  importAll (userOrUserId: UserOrId, data: unknown[], callback: Callback<unknown>): void;
  clearAll (userOrUserId: UserOrId, callback: Callback<unknown>): void;
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