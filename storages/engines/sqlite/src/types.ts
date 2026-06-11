/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Canonical structural slice of the better-sqlite3 surface this engine
 * touches. Import these instead of redeclaring per file; pick the row shape
 * at the prepare site (`db.prepare<MyRow>(sql)`).
 */

/** Values that better-sqlite3 / our bind sites accept as a bound parameter. */
export type SqlParam = string | number | bigint | null | Buffer | Uint8Array;

export type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };

export type SqliteStmt<Row = Record<string, unknown>> = {
  run: (...params: unknown[]) => SqliteRunResult;
  get: (...params: unknown[]) => Row | undefined;
  all: (...params: unknown[]) => Row[];
  iterate: (...params: unknown[]) => IterableIterator<Row>;
};

export type SqliteDb = {
  prepare: <Row = Record<string, unknown>>(sql: string) => SqliteStmt<Row>;
  transaction: <T>(fn: (arg: T) => void) => (arg: T) => void;
  close: () => void;
};
