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
  // Mirrors better-sqlite3: wrapping a fn returns a callable with the same
  // args that runs it in a transaction and forwards its return value (so a
  // no-arg fn returning a value — e.g. the accesses integrity tx — typechecks).
  transaction: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R;
  close: () => void;
};
