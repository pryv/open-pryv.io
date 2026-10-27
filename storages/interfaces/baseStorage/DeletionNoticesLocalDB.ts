/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The core's outbox of CMC revoke notices sent while an account was deleted
 * and not yet delivered: the account (and its own retry queue) is gone, so
 * the notices wait here, one row each, until delivered (row deleted) or given
 * up (`failed-permanent`, kept without the credential, pruned later).
 * Core-level, never replicated: a pending row holds a token of an access on
 * another account (in `apiEndpoint`), which stays on the core the deleted
 * account lived on. Not part of any user's data, never exported.
 */

export type DeletionNoticeStatus = 'pending' | 'failed-permanent';

export interface DeletionNoticeRow {
  id: string;
  /** The deleted account's id: names nothing on the core any more. */
  deletedUserId: string;
  /** The relationship access the notice is about (deleted with the account). */
  accessId: string | null;
  /** The peer's endpoint, with its token while pending, without it once terminal. */
  apiEndpoint: string;
  path: string;
  /** The request body, as the notice was built. */
  body: unknown;
  attempts: number;
  /** Epoch ms. */
  nextAttemptAfter: number;
  status: DeletionNoticeStatus;
  lastFailureReason: string | null;
  lastFailureDetail: unknown;
  /** Epoch ms. */
  createdAt: number;
}

export interface DeletionNoticesLocalDB {
  init (): Promise<void>;
  insert (row: DeletionNoticeRow): Promise<void>;
  /** Pending rows due at `now` (ms), oldest first. */
  listDue (now: number, limit: number): Promise<DeletionNoticeRow[]>;
  countPending (): Promise<number>;
  /** Write the row's mutable fields (by id); false when no such row. */
  update (row: DeletionNoticeRow): Promise<boolean>;
  delete (id: string): Promise<boolean>;
  /** Delete the failed-permanent rows created before `createdBefore` (ms); returns how many. */
  pruneFailedBefore (createdBefore: number): Promise<number>;
  /** Every row: tools and tests only, never an API path. */
  listAll (): Promise<DeletionNoticeRow[]>;
  deleteAll (): Promise<void>;
}

const DeletionNoticesLocalDB: DeletionNoticesLocalDB = {
  async init () { throw new Error('Not implemented'); },
  async insert (row: DeletionNoticeRow): Promise<void> { throw new Error('Not implemented'); },
  async listDue (now: number, limit: number): Promise<DeletionNoticeRow[]> { throw new Error('Not implemented'); },
  async countPending (): Promise<number> { throw new Error('Not implemented'); },
  async update (row: DeletionNoticeRow): Promise<boolean> { throw new Error('Not implemented'); },
  async delete (id: string): Promise<boolean> { throw new Error('Not implemented'); },
  async pruneFailedBefore (createdBefore: number): Promise<number> { throw new Error('Not implemented'); },
  async listAll (): Promise<DeletionNoticeRow[]> { throw new Error('Not implemented'); },
  async deleteAll (): Promise<void> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(DeletionNoticesLocalDB)) {
  Object.defineProperty(DeletionNoticesLocalDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(DeletionNoticesLocalDB);

function validateDeletionNoticesLocalDB (instance: unknown): DeletionNoticesLocalDB {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`DeletionNoticesLocalDB implementation missing method: ${method}`);
    }
  }
  return obj as unknown as DeletionNoticesLocalDB;
}

export { DeletionNoticesLocalDB, validateDeletionNoticesLocalDB };
