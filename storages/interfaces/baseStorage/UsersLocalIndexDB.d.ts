/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface UsersLocalIndexDB {
  init(): Promise<void>;
  addUser(username: string, userId: string): Promise<any>;
  getIdForName(username: string): Promise<string | undefined>;
  getNameForId(userId: string): Promise<string | undefined>;
  getAllByUsername(): Promise<Record<string, string>>;
  deleteAll(): Promise<void>;
  deleteById(userId: string): Promise<void>;
  exportAll(): Promise<Record<string, string>>;
  importAll(data: Record<string, string>): Promise<void>;
  clearAll(): Promise<void>;
}

export declare const UsersLocalIndexDB: UsersLocalIndexDB;
export declare function validateUsersLocalIndexDB(instance: any): UsersLocalIndexDB;
