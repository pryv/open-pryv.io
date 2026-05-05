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

type Callback<T = any> = (err: Error | null, result?: T) => void;

export interface Sessions {
  get (id: string, callback: Callback<any>): void;
  getMatching (data: Record<string, any>, callback: Callback<string | null>): void;
  generate (data: Record<string, any>, options: Record<string, any> | null, callback: Callback<string>): void;
  touch (id: string, callback: Callback<any>): void;
  destroy (id: string, callback: Callback<any>): void;
  clearAll (callback: Callback<any>): void;
  expireNow (id: string, callback: Callback<any>): void;
  remove (query: Record<string, any>, callback: Callback<any>): void;

  // Migration methods
  exportAll (callback: Callback<any[]>): void;
  importAll (data: any[], callback: Callback<any>): void;
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

function validateSessions (instance: any): Sessions {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`Sessions implementation missing method: ${method}`);
    }
  }
  return instance;
}

export { validateSessions, REQUIRED_METHODS };