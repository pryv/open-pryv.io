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

export interface PasswordResetRequests {
  get (id: string, username: string, callback: Callback<any>): void;
  generate (username: string, callback: Callback<string>): void;
  destroy (id: string, username: string, callback: Callback<any>): void;
  clearAll (callback: Callback<any>): void;

  // Migration methods
  exportAll (callback: Callback<any[]>): void;
  importAll (data: Array<Record<string, unknown>>, callback: Callback<any>): void;
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