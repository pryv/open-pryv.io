/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Collection info returned by getCollectionInfo().
 */
export interface CollectionInfo {
  name: string;
  indexes: Array<{ index: Record<string, number>; options?: Record<string, any> }>;
  useUserId: string;
}

type Callback<T = any> = (err: Error | null, result?: T) => void;

/**
 * Common contract for all user-scoped BaseStorage subclasses.
 * Callback-based API matching the existing MongoDB implementation.
 */
export interface UserStorage {
  getCollectionInfo(userOrUserId: string | { id: string }): CollectionInfo;

  find(userOrUserId: string | { id: string }, query: Record<string, any>, options: Record<string, any> | null, callback: Callback<any[]>): void;
  findOne(userOrUserId: string | { id: string }, query: Record<string, any>, options: Record<string, any> | null, callback: Callback<any>): void;
  insertOne(userOrUserId: string | { id: string }, item: Record<string, any>, callback: Callback<any>, options?: Record<string, any>): void;
  findOneAndUpdate(userOrUserId: string | { id: string }, query: Record<string, any>, updatedData: Record<string, any>, callback: Callback<any>): void;
  updateOne(userOrUserId: string | { id: string }, query: Record<string, any>, updatedData: Record<string, any>, callback: Callback<any>): void;
  updateMany(userOrUserId: string | { id: string }, query: Record<string, any>, updatedData: Record<string, any>, callback: Callback<any>): void;

  delete(userOrUserId: string | { id: string }, query: Record<string, any>, callback: Callback<any>): void;
  removeOne(userOrUserId: string | { id: string }, query: Record<string, any>, callback: Callback<any>): void;
  removeMany(userOrUserId: string | { id: string }, query: Record<string, any>, callback: Callback<any>): void;
  removeAll(userOrUserId: string | { id: string }, callback: Callback<any>): void;

  count(userOrUserId: string | { id: string }, query: Record<string, any>, callback: Callback<number>): void;
  countAll(userOrUserId: string | { id: string }, callback: Callback<number>): void;

  findDeletions(userOrUserId: string | { id: string }, deletedSince: number, options: Record<string, any> | null, callback: Callback<any[]>): void;

  // Migration methods — operate directly on the database, bypassing converters
  exportAll(userOrUserId: string | { id: string }, callback: Callback<any[]>): void;
  importAll(userOrUserId: string | { id: string }, data: any[], callback: Callback<any>): void;
  clearAll(userOrUserId: string | { id: string }, callback: Callback<any>): void;
}

export declare function validateUserStorage(instance: any): UserStorage;

export declare const REQUIRED_METHODS: string[];
