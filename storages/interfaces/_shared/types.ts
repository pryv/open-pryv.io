/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared types used across storages/interfaces/.
 *
 * Extracted to deduplicate inline declarations that previously lived
 * in 3+ interface files (Callback in Sessions, PasswordResetRequests,
 * UserStorage; UserOrId in UserStorage).
 */

/** Node-style callback shape used by every legacy interface method that
 *  returns its result via `(err, result)` instead of a Promise. */
export type Callback<T = unknown> = (err: Error | null, result?: T) => void;

/** A user reference accepted by interface methods that key on user identity.
 *  Either the bare user id string, or an object containing it. */
export type UserOrId = string | { id: string };

/** events.get `state` filter: which trashed-ness bucket to return.
 *  Sites that accept unvalidated wire input widen with `| string`/`| null`. */
export type EventsQueryState = 'default' | 'trashed' | 'all';

// ---- Document-store boundary types (shared by the engine bases) ----
// One canonical declaration; previously duplicated in BaseStoragePG.ts and
// BaseStorageSQLite.ts. Engines may narrow promoted-column field types
// locally (e.g. SQLite intersects `headId`/`deleted` with its bind-param
// union) — the narrowing intersects with `unknown`, so it stays compatible.

/**
 * An engine-agnostic document. `id`/`deleted`/`headId` map to promoted
 * columns; other fields are genuinely arbitrary per collection (`unknown`).
 */
export type StoredItem = { id?: string, deleted?: unknown, headId?: unknown, [k: string]: unknown };
export type ItemList = Array<StoredItem | null>;

/** Mongo-style query: field → scalar | operator-object | $or. */
export type Query = Record<string, unknown>;

/** Mongo-style update: $set/$unset/$inc/$min/$max + bare fields (treated as $set). */
export type UpdateData = {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
  $inc?: Record<string, unknown>;
  $min?: Record<string, unknown>;
  $max?: Record<string, unknown>;
  $pull?: unknown;
  [field: string]: unknown;
};

/** Operator-object value of a query field (the `{ $gt: x, $in: [...] }` shape). */
export type QueryOp = {
  $eq?: unknown, $ne?: unknown,
  $gt?: unknown, $gte?: unknown, $lt?: unknown, $lte?: unknown,
  $in?: unknown[], $type?: string
};

/** find/count options accepted by the engine-base query methods. */
export type FindOptions = {
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
  projection?: Record<string, number | boolean>;
} | null | undefined;

// ---- Logging ----

/** Structural logger contract for storages/engines. Mirror of @pryv/boiler's
 *  `Logger`/`LogFn` exports — engines must not depend on boiler (plugin
 *  isolation), so the pair is declared on both sides; keep them in sync. */
export type LogFn = (...args: unknown[]) => void;
export type Logger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };
