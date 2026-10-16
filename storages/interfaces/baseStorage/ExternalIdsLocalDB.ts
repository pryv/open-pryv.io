/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The home core's table of external ids: which local account holds each id.
 * Never replicated: the platform rows only say which core holds an id.
 *
 * Two unique constraints, enforced by the engine:
 *   - (nsToken, valueToken): one account per id. This is the authoritative
 *     uniqueness step, since two accounts of the same core both "win" the
 *     platform row.
 *   - (userId, nsToken): one id per account per namespace.
 */

export interface ExternalIdRow {
  userId: string;
  nsToken: string;
  valueToken: string;
  /** Canonical base64url; kept so the platform rows can be rebuilt (pepper rotation, core move). */
  blindedValue: string;
  /** Epoch seconds. */
  claimedAt: number;
}

export type ExternalIdConflictReason = 'value-taken' | 'namespace-taken';

/** Thrown by `insert` / `replaceForUser` on either unique constraint. */
export class ExternalIdConflict extends Error {
  reason: ExternalIdConflictReason;
  constructor (reason: ExternalIdConflictReason) {
    super('external id conflict: ' + reason);
    this.name = 'ExternalIdConflict';
    this.reason = reason;
  }
}

export interface ExternalIdsLocalDB {
  init (): Promise<void>;
  insert (row: ExternalIdRow): Promise<void>;
  getByUser (userId: string): Promise<ExternalIdRow[]>;
  getByTokens (nsToken: string, valueToken: string): Promise<ExternalIdRow | null>;
  getByUserAndNamespace (userId: string, nsToken: string): Promise<ExternalIdRow | null>;
  /** Replace the user's id in that namespace (one UPDATE); conflict when the new value is held. */
  replaceForUser (userId: string, nsToken: string, values: { valueToken: string, blindedValue: string, claimedAt: number }): Promise<void>;
  deleteByUserAndNamespace (userId: string, nsToken: string): Promise<boolean>;
  deleteByUser (userId: string): Promise<number>;
  /** Every row of this core: reconcile, pepper rotation, backup. */
  scanAll (): Promise<ExternalIdRow[]>;
  deleteAll (): Promise<void>;
}

const ExternalIdsLocalDB: ExternalIdsLocalDB = {
  async init () { throw new Error('Not implemented'); },
  async insert (row: ExternalIdRow): Promise<void> { throw new Error('Not implemented'); },
  async getByUser (userId: string): Promise<ExternalIdRow[]> { throw new Error('Not implemented'); },
  async getByTokens (nsToken: string, valueToken: string): Promise<ExternalIdRow | null> { throw new Error('Not implemented'); },
  async getByUserAndNamespace (userId: string, nsToken: string): Promise<ExternalIdRow | null> { throw new Error('Not implemented'); },
  async replaceForUser (userId: string, nsToken: string, values: { valueToken: string, blindedValue: string, claimedAt: number }): Promise<void> { throw new Error('Not implemented'); },
  async deleteByUserAndNamespace (userId: string, nsToken: string): Promise<boolean> { throw new Error('Not implemented'); },
  async deleteByUser (userId: string): Promise<number> { throw new Error('Not implemented'); },
  async scanAll (): Promise<ExternalIdRow[]> { throw new Error('Not implemented'); },
  async deleteAll (): Promise<void> { throw new Error('Not implemented'); }
};

for (const propName of Object.getOwnPropertyNames(ExternalIdsLocalDB)) {
  Object.defineProperty(ExternalIdsLocalDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(ExternalIdsLocalDB);

function validateExternalIdsLocalDB (instance: unknown): ExternalIdsLocalDB {
  const obj = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      throw new Error(`ExternalIdsLocalDB implementation missing method: ${method}`);
    }
  }
  return obj as unknown as ExternalIdsLocalDB;
}

export { ExternalIdsLocalDB, validateExternalIdsLocalDB };
