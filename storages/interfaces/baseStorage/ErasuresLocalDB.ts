/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The core's record of account erasures in progress: one row per account
 * being erased, written before the first erasure step and removed once the
 * last one completed. The erasure removes the account's own data (its index
 * entry, its rows, its directory) and so cannot keep this record there; a row
 * left behind (a failed step, a crash) names an erasure to complete, with the
 * steps already done. Core-level, never replicated, outside any user's data.
 */

export interface AccountErasureRow {
  userId: string;
  username: string;
  /** What decided the erasure (e.g. `admin`, `holder`, `date`, `inactivity`), null when unknown. */
  trigger: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms of the last change: an erasure still running keeps it fresh. */
  updatedAt: number;
  /** Names of the steps completed, in order. */
  doneSteps: string[];
  /** The account's series namespaces, as computed while its aliases were still known. */
  seriesNamespaces: string[] | null;
  attempts: number;
  lastError: string | null;
}

export interface ErasuresLocalDB {
  init (): Promise<void>;
  /** Insert or replace the row of `row.userId`. */
  put (row: AccountErasureRow): Promise<void>;
  /** Insert `row` unless the account already has one; false when it had. */
  insertIfAbsent (row: AccountErasureRow): Promise<boolean>;
  /**
   * Compare-and-set of `updatedAt`: true when the row still had
   * `expectedUpdatedAt` and now has `updatedAt` (whoever wins takes the
   * erasure over; the others see false).
   */
  claim (userId: string, expectedUpdatedAt: number, updatedAt: number): Promise<boolean>;
  get (userId: string): Promise<AccountErasureRow | null>;
  /** Every row, oldest first. */
  listAll (): Promise<AccountErasureRow[]>;
  delete (userId: string): Promise<boolean>;
  /** Tools and tests only. */
  deleteAll (): Promise<void>;
}

const ErasuresLocalDB: ErasuresLocalDB = {
  async init () { throw new Error('Not implemented'); },
  async put (row: AccountErasureRow): Promise<void> { throw new Error('Not implemented'); },
  async insertIfAbsent (row: AccountErasureRow): Promise<boolean> { throw new Error('Not implemented'); },
  async claim (userId: string, expectedUpdatedAt: number, updatedAt: number): Promise<boolean> { throw new Error('Not implemented'); },
  async get (userId: string): Promise<AccountErasureRow | null> { throw new Error('Not implemented'); },
  async listAll (): Promise<AccountErasureRow[]> { throw new Error('Not implemented'); },
  async delete (userId: string): Promise<boolean> { throw new Error('Not implemented'); },
  async deleteAll (): Promise<void> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(ErasuresLocalDB)) {
  Object.defineProperty(ErasuresLocalDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(ErasuresLocalDB);

function validateErasuresLocalDB (instance: unknown): ErasuresLocalDB {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`ErasuresLocalDB implementation missing method: ${method}`);
    }
  }
  return obj as unknown as ErasuresLocalDB;
}

export { ErasuresLocalDB, validateErasuresLocalDB };
