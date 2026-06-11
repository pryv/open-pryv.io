/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PasswordResetRequests interface — contract for the global password reset storage.
 * Callback-based API matching the existing MongoDB implementation.
 *
 * Use {@link validatePasswordResetRequests} to verify class-based instances.
 */

import type { Callback } from '../_shared/types.ts';

/** Mongo-era reset-request document (`_id`-keyed, Date-typed) as delivered
 *  by get/exportAll; importAll accepts looser legacy variants. */
export type PasswordResetDoc = { _id: string; username: string; expires: Date };
export type PasswordResetImportDoc = { _id?: string; id?: string; username: string; expires: Date | number | string };

export interface PasswordResetRequests {
  get (id: string, username: string, callback: Callback<PasswordResetDoc | null>): void;
  generate (username: string, callback: Callback<string>): void;
  // destroy/clearAll payloads are engine-specific write results — ignored
  // by callers, `unknown` by design.
  destroy (id: string, username: string, callback: Callback<unknown>): void;
  clearAll (callback: Callback<unknown>): void;

  // Migration methods
  exportAll (callback: Callback<PasswordResetDoc[]>): void;
  importAll (data: PasswordResetImportDoc[], callback: Callback<unknown>): void;
}

const REQUIRED_METHODS: string[] = [
  'get',
  'generate',
  'destroy',
  'clearAll',
  // Migration methods
  'exportAll',
  'importAll'
];

function validatePasswordResetRequests (instance: unknown): PasswordResetRequests {
  const inst = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof inst[method] !== 'function') {
      throw new Error(`PasswordResetRequests implementation missing method: ${method}`);
    }
  }
  return inst as unknown as PasswordResetRequests;
}

export { validatePasswordResetRequests, REQUIRED_METHODS };