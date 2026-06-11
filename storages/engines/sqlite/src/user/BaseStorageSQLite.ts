/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId } from '../../../../interfaces/_shared/types.ts';
const require = createRequire(import.meta.url);

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { _internals } = require('../_internals.ts');

type Options = {
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
  projection?: Record<string, number | boolean>;
} | null | undefined;

// ---- Precise document-store types (untyped-document ↔ typed-SQL boundary) ----

/** Values that better-sqlite3 / our bind sites accept as a bound parameter. */
type SqlParam = string | number | bigint | null | Buffer | Uint8Array;

/**
 * An engine-agnostic document. `id`/`headId`/`deleted` are promoted to SQL
 * columns; everything else is packed into the JSON `data` column. Other
 * fields are genuinely arbitrary per collection, hence `unknown`.
 */
type StoredItem = { id?: string, headId?: SqlParam, deleted?: SqlParam, [k: string]: unknown };
type ItemList = Array<StoredItem | null>;

/** Mongo-style query: field → scalar | operator-object | $or. */
type Query = Record<string, unknown>;
/** Mongo-style update: $set/$unset/$inc/$min/$max + bare fields (treated as $set). */
type UpdateData = {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
  $inc?: Record<string, unknown>;
  $min?: Record<string, unknown>;
  $max?: Record<string, unknown>;
  $pull?: unknown;
  [field: string]: unknown;
};

/** Operator-object value of a query field (the `{ $gt: x, $in: [...] }` shape). */
type QueryOp = {
  $eq?: unknown, $ne?: unknown,
  $gt?: unknown, $gte?: unknown, $lt?: unknown, $lte?: unknown,
  $in?: unknown[], $type?: string
};

/** A row read back from a baseStorage table. */
type DbRow = { id: string, head_id?: number | string | null, deleted?: number | null, data?: string, cnt?: number, [k: string]: unknown };
type SqliteStmt = {
  all: (...params: SqlParam[]) => DbRow[],
  get: (...params: SqlParam[]) => DbRow | undefined,
  run: (...params: SqlParam[]) => { changes: number }
};
type SqliteDb = {
  prepare: (sql: string) => SqliteStmt,
  transaction: (fn: (items: StoredItem[]) => void) => (items: StoredItem[]) => void
};
/** The per-user handle returned by `userDb()` — only `.db` is touched downstream. */
type UserDb = { db: SqliteDb };

/**
 * Columns stored as proper SQL columns (vs packed into `data` JSON).
 * Mirrors PG indexable columns so query semantics line up.
 */
const COL_SET = new Set(['id', 'headId', 'deleted']);

function isColColumn (name: string): boolean {
  return COL_SET.has(name);
}

function colSql (name: string): string {
  if (name === 'headId') return 'head_id';
  return name;
}

/**
 * SQLite implementation of the engine-agnostic UserStorage base.
 *
 * Storage shape: each user has their own SQLite file (managed by
 * UserBaseStorageDb). Each collection lives in a table within that file,
 * with id + headId + deleted as proper columns and everything else in a
 * JSON `data` column queried via json_extract.
 *
 * Subclasses declare:
 *   this.tableName
 *   this.hasDeletedCol  (default true)
 *   this.hasHeadIdCol   (default false)
 *   this.idField        (kept for API compat; the SQLite column is always `id`)
 *   this.defaultSort    (optional)
 *
 * applyDefaults(item) can be overridden to inject defaults at insertOne.
 */
class BaseStorageSQLite {
  tableName: string | null = null;
  idField: string = 'id';
  defaultSort: string | null = null;
  hasDeletedCol: boolean = true;
  hasHeadIdCol: boolean = false;

  // ---- Helpers ----

  getUserIdFromUserOrUserId (userOrUserId: UserOrId): string {
    if (typeof userOrUserId === 'string') return userOrUserId;
    return userOrUserId.id;
  }

  getCollectionInfo (userOrUserId: UserOrId): { name: string | null, useUserId: string } {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return { name: this.tableName, useUserId: userId };
  }

  applyDefaults (item: StoredItem): StoredItem {
    return Object.assign({}, item);
  }

  private async userDb (userOrUserId: UserOrId): Promise<UserDb> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, {
      withDeleted: this.hasDeletedCol,
      withHeadId: this.hasHeadIdCol
    });
    return udb;
  }

  // ---- Row ↔ item mapping ----

  rowToItem (row: DbRow | null | undefined): StoredItem | null {
    if (!row) return null;
    const dataJson = row.data ? JSON.parse(row.data) : {};
    const item: StoredItem = Object.assign({}, dataJson);
    item.id = row.id;
    if (this.hasHeadIdCol && row.head_id != null) item.headId = row.head_id;
    if (this.hasDeletedCol && row.deleted != null) item.deleted = row.deleted;
    return item;
  }

  rowsToItems (rows: DbRow[]): ItemList {
    return rows.map((r) => this.rowToItem(r));
  }

  private itemToRow (item: StoredItem): { id: string, head_id: SqlParam, deleted: SqlParam, data: string } {
    const copy = Object.assign({}, item);
    // Document field → column-type narrowing (the document↔column boundary).
    const id = copy.id as string;
    delete copy.id;
    const head_id: SqlParam = this.hasHeadIdCol ? (copy.headId ?? null) : null;
    delete copy.headId;
    const deleted: SqlParam = this.hasDeletedCol ? (copy.deleted ?? null) : null;
    delete copy.deleted;
    return { id, head_id, deleted, data: JSON.stringify(copy) };
  }

  // ---- Query translation ----

  /**
   * Translates a mongo-style `query` to a SQL `WHERE` fragment + bound params.
   * Indexed columns (id, headId, deleted) are read directly; everything else
   * uses json_extract(data, '$.<prop>').
   *
   * Supported operators per field: equality, $eq, $ne, $gt, $gte, $lt, $lte,
   * $in, $type ('null' / 'number' map to IS NULL / IS NOT NULL). Top-level
   * $or supported.
   */
  buildWhere (query: Query): { sql: string, params: SqlParam[] } {
    const conditions: string[] = [];
    const params: SqlParam[] = [];

    const pushFieldOp = (lvalue: string, op: string, val: unknown): void => {
      conditions.push(`${lvalue} ${op} ?`);
      params.push(this.paramFor(val));
    };

    const lvalueFor = (prop: string): string => {
      if (isColColumn(prop)) return colSql(prop);
      return `json_extract(data, '$.${prop}')`;
    };

    for (const [prop, val] of Object.entries(query)) {
      if (prop === '$or') {
        const orParts: string[] = [];
        for (const clause of val as Array<Record<string, unknown>>) {
          const subConds: string[] = [];
          for (const [k, v] of Object.entries(clause)) {
            const lv = lvalueFor(k);
            if (v === null) {
              subConds.push(`${lv} IS NULL`);
            } else if (typeof v === 'object' && !Array.isArray(v) && v !== null) {
              this.translateOps(lv, v as QueryOp, subConds, params);
            } else {
              subConds.push(`${lv} = ?`);
              params.push(this.paramFor(v));
            }
          }
          if (subConds.length > 0) orParts.push('(' + subConds.join(' AND ') + ')');
        }
        if (orParts.length > 0) conditions.push('(' + orParts.join(' OR ') + ')');
        continue;
      }

      const lv = lvalueFor(prop);
      if (val === null) {
        conditions.push(`${lv} IS NULL`);
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        this.translateOps(lv, val as QueryOp, conditions, params);
      } else {
        pushFieldOp(lv, '=', val);
      }
    }

    const sql = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { sql, params };
  }

  private translateOps (lvalue: string, val: QueryOp, conds: string[], params: SqlParam[]): void {
    if (val.$eq !== undefined) {
      if (val.$eq === null) conds.push(`${lvalue} IS NULL`);
      else { conds.push(`${lvalue} = ?`); params.push(this.paramFor(val.$eq)); }
    }
    if (val.$ne !== undefined) {
      if (val.$ne === null) conds.push(`${lvalue} IS NOT NULL`);
      else { conds.push(`${lvalue} != ?`); params.push(this.paramFor(val.$ne)); }
    }
    if (val.$gt !== undefined) { conds.push(`${lvalue} > ?`); params.push(this.paramFor(val.$gt)); }
    if (val.$gte !== undefined) { conds.push(`${lvalue} >= ?`); params.push(this.paramFor(val.$gte)); }
    if (val.$lt !== undefined) { conds.push(`${lvalue} < ?`); params.push(this.paramFor(val.$lt)); }
    if (val.$lte !== undefined) { conds.push(`${lvalue} <= ?`); params.push(this.paramFor(val.$lte)); }
    if (val.$in !== undefined) {
      const placeholders = val.$in.map(() => '?').join(', ');
      conds.push(`${lvalue} IN (${placeholders})`);
      for (const item of val.$in) params.push(this.paramFor(item));
    }
    if (val.$type !== undefined) {
      if (val.$type === 'null') conds.push(`${lvalue} IS NULL`);
      else if (val.$type === 'number') conds.push(`${lvalue} IS NOT NULL`);
    }
  }

  private paramFor (val: unknown): SqlParam {
    if (val === undefined) return null;
    if (val instanceof Date) return val.getTime();
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val as SqlParam;
  }

  // ---- Defaults injection ----

  private addImplicitFilters (query: Query): Query {
    const out = Object.assign({}, query);
    if (this.hasDeletedCol && out.deleted === undefined) out.deleted = null;
    if (this.hasHeadIdCol && out.headId === undefined) out.headId = null;
    return out;
  }

  // ---- CRUD ----

  /**
   * Drop fields named in `options.projection` (any falsy value = exclude).
   * Mirrors PG's `applyExclusions` for the `{ calls: 0, deleted: 0 }`
   * pattern api-server uses to strip internal counters from accesses
   * before exposing them in the API response.
   */
  private applyProjection (items: ItemList, options: Options): ItemList {
    const projection = options?.projection;
    if (!projection || Object.keys(projection).length === 0) return items;
    const excludeProps = Object.entries(projection)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (excludeProps.length === 0) return items;
    for (const item of items) {
      if (item == null) continue;
      for (const prop of excludeProps) delete item[prop];
    }
    return items;
  }

  find (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<ItemList>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = this.addImplicitFilters(query || {});
      const { sql: where, params } = this.buildWhere(q);
      const orderBy = this.buildOrderBy(options);
      const { clause: lim } = this.buildLimitOffset(options);
      const sql = `SELECT * FROM ${this.tableName} ${where} ${orderBy}${lim}`.trim();
      const rows = udb.db.prepare(sql).all(...params);
      callback(null, this.applyProjection(this.rowsToItems(rows), options));
    });
  }

  findIncludingDeletionsAndVersions (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<ItemList>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const orderBy = this.buildOrderBy(options);
      const { clause: lim } = this.buildLimitOffset(options);
      const sql = `SELECT * FROM ${this.tableName} ${where} ${orderBy}${lim}`.trim();
      const rows = udb.db.prepare(sql).all(...params);
      callback(null, this.applyProjection(this.rowsToItems(rows), options));
    });
  }

  findOne (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<StoredItem | null>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = this.addImplicitFilters(query || {});
      const { sql: where, params } = this.buildWhere(q);
      const sql = `SELECT * FROM ${this.tableName} ${where} LIMIT 1`.trim();
      const row = udb.db.prepare(sql).get(...params);
      if (!row) return callback(null, null);
      const item = this.rowToItem(row);
      const arr = this.applyProjection([item], options);
      callback(null, arr[0]);
    });
  }

  findDeletion (userOrUserId: UserOrId, query: Query, _options: Options, callback: Callback<StoredItem | null>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = Object.assign({}, query || {}, { deleted: { $ne: null } });
      const { sql: where, params } = this.buildWhere(q);
      const sql = `SELECT * FROM ${this.tableName} ${where} LIMIT 1`.trim();
      const row = udb.db.prepare(sql).get(...params);
      callback(null, row ? this.rowToItem(row) : null);
    });
  }

  findDeletions (userOrUserId: UserOrId, deletedSince: number, options: Options, callback: Callback<ItemList>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q: Query = { deleted: { $gt: deletedSince } };
      if (this.hasHeadIdCol) q.headId = null;
      const { sql: where, params } = this.buildWhere(q);
      const orderBy = this.buildOrderBy(options);
      const { clause: lim } = this.buildLimitOffset(options);
      const sql = `SELECT * FROM ${this.tableName} ${where} ${orderBy}${lim}`.trim();
      const rows = udb.db.prepare(sql).all(...params);
      callback(null, this.rowsToItems(rows));
    });
  }

  insertOne (userOrUserId: UserOrId, item: StoredItem, callback: Callback<StoredItem | null>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const prepared = this.applyDefaults(item);
      const { id, head_id, deleted, data } = this.itemToRow(prepared);
      const cols: string[] = ['id'];
      const placeholders: string[] = ['?'];
      const vals: SqlParam[] = [id];
      if (this.hasHeadIdCol) { cols.push('head_id'); placeholders.push('?'); vals.push(head_id); }
      if (this.hasDeletedCol) { cols.push('deleted'); placeholders.push('?'); vals.push(deleted); }
      cols.push('data'); placeholders.push('?'); vals.push(data);

      udb.db.prepare(`INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`)
        .run(...vals);

      const row = udb.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id);
      return this.rowToItem(row);
    });
  }

  findOneAndUpdate (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<StoredItem | null>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const row = udb.db.prepare(`SELECT * FROM ${this.tableName} ${where} LIMIT 1`).get(...params);
      if (!row) return null;
      const merged = this.applyUpdateToItem(this.rowToItem(row), updatedData);
      this._writeMerged(udb, row.id, merged);
      const updated = udb.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(row.id);
      return this.rowToItem(updated);
    });
  }

  updateOne (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<StoredItem | null>): void {
    this.findOneAndUpdate(userOrUserId, query, updatedData, callback);
  }

  updateMany (userOrUserId: UserOrId, query: Query, updatedData: UpdateData, callback: Callback<{ modifiedCount: number }>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const rows = udb.db.prepare(`SELECT * FROM ${this.tableName} ${where}`).all(...params);
      let modified = 0;
      for (const r of rows) {
        const merged = this.applyUpdateToItem(this.rowToItem(r), updatedData);
        this._writeMerged(udb, r.id, merged);
        modified++;
      }
      return { modifiedCount: modified };
    });
  }

  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number }>): void {
    const now = require('unix-timestamp').now();
    this.updateMany(userOrUserId, query, { $set: { deleted: now } }, callback);
  }

  removeOne (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const row = udb.db.prepare(`SELECT id FROM ${this.tableName} ${where} LIMIT 1`).get(...params);
      if (!row) return 0;
      udb.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(row.id);
      return 1;
    });
  }

  removeMany (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const res = udb.db.prepare(`DELETE FROM ${this.tableName} ${where}`).run(...params);
      return res.changes;
    });
  }

  removeAll (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.removeMany(userOrUserId, {}, callback);
  }

  count (userOrUserId: UserOrId, query: Query, callback: Callback<number>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = this.addImplicitFilters(query || {});
      const { sql: where, params } = this.buildWhere(q);
      const row = udb.db.prepare(`SELECT COUNT(*) AS cnt FROM ${this.tableName} ${where}`).get(...params);
      callback(null, row?.cnt ?? 0);
    });
  }

  countAll (userOrUserId: UserOrId, callback: Callback<number>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const row = udb.db.prepare(`SELECT COUNT(*) AS cnt FROM ${this.tableName}`).get();
      callback(null, row?.cnt ?? 0);
    });
  }

  async * iterateAll (): AsyncGenerator<StoredItem | null> {
    const { getUsersLocalIndex } = require('storage');
    const idx = await getUsersLocalIndex();
    const map = await idx.getAllByUsername();
    for (const userId of Object.values(map) as string[]) {
      const udb = await UserBaseStorageDb.forUser(userId);
      await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
      const rows = udb.db.prepare(`SELECT * FROM ${this.tableName}`).all();
      for (const row of rows) {
        yield this.rowToItem(row);
      }
    }
  }

  // ---- Migration ----

  exportAll (userOrUserId: UserOrId, callback: Callback<ItemList>): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const rows = udb.db.prepare(`SELECT * FROM ${this.tableName}`).all();
      callback(null, this.rowsToItems(rows));
    });
  }

  importAll (userOrUserId: UserOrId, items: StoredItem[], callback: Callback<void>): void {
    if (!items || items.length === 0) return callback(null);
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const cols: string[] = ['id'];
      const placeholders: string[] = ['?'];
      if (this.hasHeadIdCol) { cols.push('head_id'); placeholders.push('?'); }
      if (this.hasDeletedCol) { cols.push('deleted'); placeholders.push('?'); }
      cols.push('data'); placeholders.push('?');
      const stmt = udb.db.prepare(`INSERT OR IGNORE INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`);
      const tx = udb.db.transaction((arr: StoredItem[]) => {
        for (const it of arr) {
          const row = this.itemToRow(this.applyDefaults(it));
          const vals: SqlParam[] = [row.id];
          if (this.hasHeadIdCol) vals.push(row.head_id);
          if (this.hasDeletedCol) vals.push(row.deleted);
          vals.push(row.data);
          stmt.run(...vals);
        }
      });
      tx(items);
      return null;
    });
  }

  clearAll (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.removeAll(userOrUserId, callback);
  }

  // ---- Update merging ----

  private applyUpdateToItem (item: StoredItem | null, updatedData: UpdateData): StoredItem {
    const merged: StoredItem = Object.assign({}, item);
    const $set: Record<string, unknown> = updatedData.$set || {};
    const $unset: Record<string, unknown> = updatedData.$unset || {};
    const $inc: Record<string, unknown> = updatedData.$inc || {};
    const $min: Record<string, unknown> = updatedData.$min || {};
    const $max: Record<string, unknown> = updatedData.$max || {};

    for (const [k, v] of Object.entries(updatedData)) {
      if (!k.startsWith('$')) {
        $set[k] = v;
      }
    }

    // Auto-expand $set values that are plain objects targeting a
    // JSONB-equivalent column (everything stored under SQLite's `data`
    // TEXT column counts). Mirrors PG's `_buildUpdateClauses` logic:
    // `{data: {keyOne: 'v', keyTwo: null}}` MUST merge with the existing
    // `data` (treating `null` as delete), not replace it wholesale.
    // Profile/clientData/etc updates rely on this — the test fixtures
    // pass `{data: {...partial}}` and expect a deep merge against the
    // currently-stored data.
    for (const [k, v] of Object.entries($set)) {
      if (v == null || typeof v !== 'object' || Array.isArray(v)) continue;
      if (COL_SET.has(k)) continue; // indexed col — value is the column value, not a nested map
      const existing = merged[k];
      if (existing != null && typeof existing === 'object' && !Array.isArray(existing)) {
        const mergedField = Object.assign({}, existing) as Record<string, unknown>;
        for (const [subKey, subVal] of Object.entries(v as Record<string, unknown>)) {
          if (subVal === null) delete mergedField[subKey];
          else mergedField[subKey] = subVal;
        }
        $set[k] = mergedField;
      }
    }

    for (const [k, v] of Object.entries($set)) {
      this.setNested(merged, k, v);
    }
    for (const k of Object.keys($unset)) {
      this.unsetNested(merged, k);
    }
    // $inc/$min/$max operand values are numeric by the mongo update contract.
    for (const [k, v] of Object.entries($inc) as Array<[string, number]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, (typeof cur === 'number' ? cur : 0) + v);
    }
    for (const [k, v] of Object.entries($min) as Array<[string, number]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, cur == null ? v : Math.min(cur as number, v));
    }
    for (const [k, v] of Object.entries($max) as Array<[string, number]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, cur == null ? v : Math.max(cur as number, v));
    }

    return merged;
  }

  private setNested (obj: Record<string, unknown>, path: string, val: unknown): void {
    const parts = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = val;
  }

  private unsetNested (obj: Record<string, unknown>, path: string): void {
    const parts = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) return;
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    delete cur[parts[parts.length - 1]];
  }

  private getNested (obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }

  private _writeMerged (udb: UserDb, id: string, merged: StoredItem): void {
    const row = this.itemToRow(Object.assign({}, merged, { id }));
    const cols: string[] = [];
    const vals: SqlParam[] = [];
    if (this.hasHeadIdCol) { cols.push('head_id = ?'); vals.push(row.head_id); }
    if (this.hasDeletedCol) { cols.push('deleted = ?'); vals.push(row.deleted); }
    cols.push('data = ?'); vals.push(row.data);
    vals.push(id);
    udb.db.prepare(`UPDATE ${this.tableName} SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ---- Order/limit ----

  buildOrderBy (options: Options): string {
    const sort = options?.sort;
    if (sort && Object.keys(sort).length > 0) {
      const parts = Object.entries(sort).map(([k, v]) => {
        const lv = isColColumn(k) ? colSql(k) : `json_extract(data, '$.${k}')`;
        return `${lv} ${v === -1 ? 'DESC' : 'ASC'}`;
      });
      return 'ORDER BY ' + parts.join(', ');
    }
    if (this.defaultSort) return 'ORDER BY ' + this.defaultSort;
    return '';
  }

  buildLimitOffset (options: Options): { clause: string } {
    let clause = '';
    if (options?.limit) clause += ` LIMIT ${Number(options.limit)}`;
    if (options?.skip) {
      if (!options?.limit) clause += ' LIMIT -1';
      clause += ` OFFSET ${Number(options.skip)}`;
    }
    return { clause };
  }

  // ---- Test/extra helpers ----

  findAll (userOrUserId: UserOrId, options: Options, callback: Callback<ItemList>): void {
    // Mirror PG's findAll: do NOT apply implicit filters (deleted=null,
    // headId=null), so the result includes deleted + versioned rows.
    // Used by test fixtures (`accesses-app.test.js` etc.) to assert on
    // deletion-tombstone state after a soft-delete.
    this.findIncludingDeletionsAndVersions(userOrUserId, {}, options, callback);
  }

  insertMany (userOrUserId: UserOrId, items: StoredItem[], callback: Callback<void>): void {
    this.importAll(userOrUserId, items, callback);
  }

  dropCollection (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.removeAll(userOrUserId, callback);
  }

  dropCollectionFully (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.removeAll(userOrUserId, callback);
  }

  listIndexes (_userOrUserId: UserOrId, _options: unknown, callback: Callback<ItemList>): void {
    callback(null, []);
  }

  findAndUpdateIfNeeded (userOrUserId: UserOrId, query: Query, options: Options, updateIfNeededCallback: (item: StoredItem | null) => UpdateData | null, callback: Callback<{ count: number }>): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const orderBy = this.buildOrderBy(options);
      const rows = udb.db.prepare(`SELECT * FROM ${this.tableName} ${where} ${orderBy}`.trim()).all(...params);
      let updates = 0;
      for (const r of rows) {
        const item = this.rowToItem(r);
        const updateQuery = updateIfNeededCallback(item);
        if (updateQuery == null) continue;
        const merged = this.applyUpdateToItem(item, updateQuery);
        this._writeMerged(udb, r.id, merged);
        updates++;
      }
      return { count: updates };
    });
  }

  // ---- Async / write plumbing ----

  private _userDbAnd<T> (userOrUserId: UserOrId, callback: Callback<T>, fn: (udb: UserDb) => void): void {
    this.userDb(userOrUserId)
      .then((udb) => {
        try { fn(udb); } catch (err) { callback(err as Error); }
      })
      .catch(callback);
  }

  private _userDbAndWrite<T> (userOrUserId: UserOrId, callback: Callback<T>, fn: (udb: UserDb) => T): void {
    this.userDb(userOrUserId)
      .then(async (udb) => {
        try {
          let result: T | undefined;
          await concurrentSafeWrite.execute(() => { result = fn(udb); });
          callback(null, result);
        } catch (err) { callback(err as Error); }
      })
      .catch(callback);
  }
}

export { BaseStorageSQLite };
