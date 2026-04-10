/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface StoreKeyValueData {
  getAll(userId: string): Promise<Record<string, any>>;
  get(userId: string, key: string): Promise<any>;
  set(userId: string, key: string, value: any): Promise<void>;
}

export interface PasswordEntry {
  time: number;
  hash: string;
  createdBy: string;
}

export interface UserAccountStorageExport {
  passwords: PasswordEntry[];
  storeKeyValues: Array<{ storeId: string; key: string; value: any }>;
}

export interface UserAccountStorage {
  init(): Promise<void>;
  addPasswordHash(userId: string, hash: string, createdBy: string, time?: number): Promise<PasswordEntry>;
  getPasswordHash(userId: string): Promise<string | null>;
  getCurrentPasswordTime(userId: string): Promise<number>;
  passwordExistsInHistory(userId: string, password: string, historyLength: number): Promise<boolean>;
  clearHistory(userId: string): Promise<void>;
  getKeyValueDataForStore(storeId: string): StoreKeyValueData;
  _exportAll(userId: string): Promise<UserAccountStorageExport>;
  _importAll(userId: string, data: UserAccountStorageExport): Promise<void>;
  _clearAll(userId: string): Promise<void>;
}

export declare const UserAccountStorage: UserAccountStorage;
export declare function createUserAccountStorage(implementation: Partial<UserAccountStorage>): UserAccountStorage;
