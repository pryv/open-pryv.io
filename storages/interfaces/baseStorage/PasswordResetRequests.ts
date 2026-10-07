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

import { createHash } from 'node:crypto';
import type { Callback } from '../_shared/types.ts';

/** Mongo-era reset-request document (`_id`-keyed, Date-typed) as delivered
 *  by get/exportAll; importAll accepts looser legacy variants. `_id` is the
 *  hex sha256 of the mailed token: the token itself is never stored. */
export type PasswordResetDoc = { _id: string; username: string; expires: Date };
export type PasswordResetImportDoc = { _id?: string; id?: string; username: string; expires: Date | number | string };

export interface PasswordResetRequests {
  /** Live request matching the token for this username, or null. */
  get (token: string, username: string, callback: Callback<PasswordResetDoc | null>): void;
  /** Replace any request of this username with a new one; returns the token.
   *  Also removes expired requests of every account: requests are 1 h-lived
   *  and only created here, so no separate sweep is needed. */
  generate (username: string, callback: Callback<string>): void;
  /** Atomically delete and return the live request matching the token for
   *  this username, or null. A token can be consumed once. */
  consume (token: string, username: string, callback: Callback<PasswordResetDoc | null>): void;
  // destroy/clearAll payloads are engine-specific write results — ignored
  // by callers, `unknown` by design.
  destroy (token: string, username: string, callback: Callback<unknown>): void;
  /** Delete every request of this username. */
  destroyAllForUser (username: string, callback: Callback<unknown>): void;
  clearAll (callback: Callback<unknown>): void;

  // Migration methods
  exportAll (callback: Callback<PasswordResetDoc[]>): void;
  importAll (data: PasswordResetImportDoc[], callback: Callback<unknown>): void;
}

/** Stored form of a reset token: hex sha256. */
function hashResetToken (token: string): string {
  return createHash('sha256').update(String(token)).digest('hex');
}

const REQUIRED_METHODS: string[] = [
  'get',
  'generate',
  'consume',
  'destroy',
  'destroyAllForUser',
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

export { validatePasswordResetRequests, hashResetToken, REQUIRED_METHODS };