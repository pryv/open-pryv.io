/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

type Callback<T = any> = (err: Error | null, result?: T) => void;

/**
 * Sessions storage interface — global (not user-scoped).
 * Callback-based API.
 */
export interface Sessions {
  get(id: string, callback: Callback<any>): void;
  getMatching(data: Record<string, any>, callback: Callback<string | null>): void;
  generate(data: Record<string, any>, options: Record<string, any> | null, callback: Callback<string>): void;
  touch(id: string, callback: Callback<any>): void;
  destroy(id: string, callback: Callback<any>): void;
  clearAll(callback: Callback<any>): void;
  expireNow(id: string, callback: Callback<any>): void;
  remove(query: Record<string, any>, callback: Callback<any>): void;

  // Migration methods
  exportAll(callback: Callback<any[]>): void;
  importAll(data: any[], callback: Callback<any>): void;
}

export declare function validateSessions(instance: any): Sessions;

export declare const REQUIRED_METHODS: string[];
