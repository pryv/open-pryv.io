/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

type Callback<T = any> = (err: Error | null, result?: T) => void;

/**
 * PasswordResetRequests storage interface — global (not user-scoped).
 * Callback-based API.
 */
export interface PasswordResetRequests {
  get(id: string, username: string, callback: Callback<any>): void;
  generate(username: string, callback: Callback<string>): void;
  destroy(id: string, username: string, callback: Callback<any>): void;
  clearAll(callback: Callback<any>): void;

  // Migration methods
  exportAll(callback: Callback<any[]>): void;
  importAll(data: any[], callback: Callback<any>): void;
}

export declare function validatePasswordResetRequests(instance: any): PasswordResetRequests;

export declare const REQUIRED_METHODS: string[];
