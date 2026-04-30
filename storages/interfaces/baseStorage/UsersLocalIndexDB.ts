/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface UsersLocalIndexDB {
  init (): Promise<void>;
  addUser (username: string, userId: string): Promise<any>;
  getIdForName (username: string): Promise<string | undefined>;
  getNameForId (userId: string): Promise<string | undefined>;
  getAllByUsername (): Promise<Record<string, string>>;
  deleteAll (): Promise<void>;
  deleteById (userId: string): Promise<void>;
  exportAll (): Promise<Record<string, string>>;
  importAll (data: Record<string, string>): Promise<void>;
  clearAll (): Promise<void>;
}

/**
 * UsersLocalIndexDB prototype object.
 * Backend implementations (MongoDB, SQLite) must provide all these methods.
 * Use {@link validateUsersLocalIndexDB} to verify class-based instances.
 */
const UsersLocalIndexDB: UsersLocalIndexDB = {
  async init () { throw new Error('Not implemented'); },

  async addUser (username: string, userId: string): Promise<any> { throw new Error('Not implemented'); },

  async getIdForName (username: string): Promise<string | undefined> { throw new Error('Not implemented'); },

  async getNameForId (userId: string): Promise<string | undefined> { throw new Error('Not implemented'); },

  async getAllByUsername (): Promise<Record<string, string>> { throw new Error('Not implemented'); },

  async deleteAll (): Promise<void> { throw new Error('Not implemented'); },

  async deleteById (userId: string): Promise<void> { throw new Error('Not implemented'); },

  // --- Migration methods --- //

  async exportAll (): Promise<Record<string, string>> { throw new Error('Not implemented'); },

  async importAll (data: Record<string, string>): Promise<void> { throw new Error('Not implemented'); },

  async clearAll (): Promise<void> { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(UsersLocalIndexDB)) {
  Object.defineProperty(UsersLocalIndexDB, propName, { configurable: false });
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(UsersLocalIndexDB);

function validateUsersLocalIndexDB (instance: any): UsersLocalIndexDB {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`UsersLocalIndexDB implementation missing method: ${method}`);
    }
  }
  return instance;
}

module.exports = { UsersLocalIndexDB, validateUsersLocalIndexDB };
