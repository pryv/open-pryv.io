/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Sessions interface — contract for the global sessions storage.
 * Callback-based API matching the existing MongoDB implementation.
 *
 * Use {@link validateSessions} to verify class-based instances.
 */

import type { Callback } from '../_shared/types.ts';

export interface Sessions {
  get (id: string, callback: Callback<unknown>): void;
  getMatching (data: Record<string, unknown>, callback: Callback<string | null>): void;
  generate (data: Record<string, unknown>, options: Record<string, unknown> | null, callback: Callback<string>): void;
  touch (id: string, callback: Callback<unknown>): void;
  destroy (id: string, callback: Callback<unknown>): void;
  clearAll (callback: Callback<unknown>): void;
  expireNow (id: string, callback: Callback<unknown>): void;
  remove (query: Record<string, unknown>, callback: Callback<unknown>): void;

  // Migration methods
  exportAll (callback: Callback<unknown[]>): void;
  importAll (data: Array<Record<string, unknown>>, callback: Callback<unknown>): void;
}

const REQUIRED_METHODS: string[] = [
  'get',
  'getMatching',
  'generate',
  'touch',
  'destroy',
  'clearAll',
  'expireNow',
  'remove',
  // Migration methods
  'exportAll',
  'importAll'
];

function validateSessions (instance: unknown): Sessions {
  const inst = instance as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof inst[method] !== 'function') {
      throw new Error(`Sessions implementation missing method: ${method}`);
    }
  }
  return inst as unknown as Sessions;
}

export { validateSessions, REQUIRED_METHODS };