/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const SQLite3 = require('better-sqlite3');
const concurrentSafeWrite = require('./concurrentSafeWrite.ts');

const { _internals } = require('./_internals.ts');

interface SqliteStmt {
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => RunResult;
  iterate: (...params: unknown[]) => Iterable<Record<string, unknown>>;
}

interface SqliteDb {
  prepare: (sql: string) => SqliteStmt;
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

class DBIndex {
  db!: SqliteDb;
  queryGetIdForName!: SqliteStmt;
  queryGetNameForId!: SqliteStmt;
  queryGetAll!: SqliteStmt;
  queryInsert!: SqliteStmt;
  queryDeleteAll!: SqliteStmt;
  queryDeleteById!: SqliteStmt;

  async init (): Promise<void> {
    const basePath = (_internals.config as { path: string }).path;
    fs.mkdirSync(basePath, { recursive: true });

    this.db = new SQLite3(basePath + '/user-index.db');
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);

    concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE TABLE IF NOT EXISTS id4name (username TEXT PRIMARY KEY, userId TEXT NOT NULL);').run();
    });
    concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS id4name_id ON id4name(userId);').run();
    });

    this.queryGetIdForName = this.db.prepare('SELECT userId FROM id4name WHERE username = ?');
    this.queryGetNameForId = this.db.prepare('SELECT username FROM id4name WHERE userId = ?');
    this.queryInsert = this.db.prepare('INSERT INTO id4name (username, userId) VALUES (@username, @userId)');
    this.queryGetAll = this.db.prepare('SELECT username, userId FROM id4name');
    this.queryDeleteById = this.db.prepare('DELETE FROM id4name WHERE userId = @userId');
    this.queryDeleteAll = this.db.prepare('DELETE FROM id4name');
  }

  async getIdForName (username: string): Promise<string | undefined> {
    return this.queryGetIdForName.get(username)?.userId as string | undefined;
  }

  async getNameForId (userId: string): Promise<string | undefined> {
    return this.queryGetNameForId.get(userId)?.username as string | undefined;
  }

  async addUser (username: string, userId: string): Promise<RunResult | null> {
    let result: RunResult | null = null;
    await concurrentSafeWrite.execute(() => {
      result = this.queryInsert.run({ username, userId });
    });
    return result;
  }

  async deleteById (userId: string): Promise<void> {
    await concurrentSafeWrite.execute(() => {
      return this.queryDeleteById.run({ userId });
    });
  }

  /**
   * @returns An object whose keys are the usernames and values are the user ids.
   */
  async getAllByUsername (): Promise<Record<string, string>> {
    const users: Record<string, string> = {};
    for (const user of this.queryGetAll.iterate() as Iterable<{ username: string, userId: string }>) {
      users[user.username] = user.userId;
    }
    return users;
  }

  async deleteAll (): Promise<void> {
    concurrentSafeWrite.execute(() => {
      return this.queryDeleteAll.run();
    });
  }

  // --- Migration methods --- //

  async exportAll (): Promise<Record<string, string>> {
    return await this.getAllByUsername();
  }

  async importAll (data: Record<string, string>): Promise<void> {
    for (const [username, userId] of Object.entries(data)) {
      await this.addUser(username, userId);
    }
  }

  async clearAll (): Promise<void> {
    return await this.deleteAll();
  }
}

export { DBIndex };
