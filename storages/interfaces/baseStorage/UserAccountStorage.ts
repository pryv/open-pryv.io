/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface StoreKeyValueData {
  getAll (userId: string): Promise<Record<string, unknown>>;
  get (userId: string, key: string): Promise<unknown>;
  set (userId: string, key: string, value: unknown): Promise<void>;
}

export interface PasswordEntry {
  time: number;
  hash: string;
  createdBy: string;
}

export interface AccountFieldEntry {
  field: string;
  value: unknown;
  time: number;
  createdBy: string;
}

export interface AccountFieldHistoryEntry {
  value: unknown;
  time: number;
  createdBy: string;
}

export interface UserAccountStorageExport {
  passwords: PasswordEntry[];
  storeKeyValues: Array<{ storeId: string, key: string, value: unknown }>;
  accountFields?: AccountFieldEntry[];
}

export interface UserAccountStorage {
  init (): Promise<void>;
  addPasswordHash (userId: string, hash: string, createdBy: string, time?: number): Promise<PasswordEntry>;
  /** Resolves to undefined when the user has no password (engine-aligned). */
  getPasswordHash (userId: string): Promise<string | undefined>;
  getCurrentPasswordTime (userId: string): Promise<number>;
  passwordExistsInHistory (userId: string, password: string, historyLength: number): Promise<boolean>;
  clearHistory (userId: string): Promise<void>;
  getKeyValueDataForStore (storeId: string): StoreKeyValueData;

  // Account fields
  getAccountFields (userId: string): Promise<Record<string, unknown>>;
  getAccountField (userId: string, field: string): Promise<unknown>;
  setAccountField (userId: string, field: string, value: unknown, createdBy: string, time?: number): Promise<AccountFieldEntry>;
  getAccountFieldHistory (userId: string, field: string, limit?: number): Promise<AccountFieldHistoryEntry[]>;
  deleteAccountField (userId: string, field: string): Promise<void>;

  // Migration methods
  _exportAll (userId: string): Promise<UserAccountStorageExport>;
  _importAll (userId: string, data: UserAccountStorageExport): Promise<void>;
  _clearAll (userId: string): Promise<void>;
}

/**
 * UserAccountStorage prototype object.
 * All implementations inherit from this via {@link createUserAccountStorage}.
 */
const UserAccountStorage: UserAccountStorage = {
  async init () { throw new Error('Not implemented'); },

  async addPasswordHash (userId: string, hash: string, createdBy: string, time?: number): Promise<PasswordEntry> { throw new Error('Not implemented'); },

  async getPasswordHash (userId: string): Promise<string | undefined> { throw new Error('Not implemented'); },

  async getCurrentPasswordTime (userId: string): Promise<number> { throw new Error('Not implemented'); },

  async passwordExistsInHistory (userId: string, password: string, historyLength: number): Promise<boolean> { throw new Error('Not implemented'); },

  async clearHistory (userId: string): Promise<void> { throw new Error('Not implemented'); },

  getKeyValueDataForStore (storeId: string): StoreKeyValueData { throw new Error('Not implemented'); },

  // --- Account fields --- //

  async getAccountFields (userId: string): Promise<Record<string, unknown>> { throw new Error('Not implemented'); },

  async getAccountField (userId: string, field: string): Promise<unknown> { throw new Error('Not implemented'); },

  async setAccountField (userId: string, field: string, value: unknown, createdBy: string, time?: number): Promise<AccountFieldEntry> { throw new Error('Not implemented'); },

  async getAccountFieldHistory (userId: string, field: string, limit?: number): Promise<AccountFieldHistoryEntry[]> { throw new Error('Not implemented'); },

  async deleteAccountField (userId: string, field: string): Promise<void> { throw new Error('Not implemented'); },

  // --- Migration methods --- //

  async _exportAll (userId: string): Promise<UserAccountStorageExport> { throw new Error('Not implemented'); },

  async _importAll (userId: string, data: UserAccountStorageExport): Promise<void> { throw new Error('Not implemented'); },

  async _clearAll (userId: string): Promise<void> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(UserAccountStorage)) {
  Object.defineProperty(UserAccountStorage, propName, { configurable: false });
}

/**
 * Create a new UserAccountStorage object with the given implementation.
 */
function createUserAccountStorage (implementation: Partial<UserAccountStorage>): UserAccountStorage {
  return Object.assign(Object.create(UserAccountStorage), implementation);
}

export { UserAccountStorage, createUserAccountStorage };