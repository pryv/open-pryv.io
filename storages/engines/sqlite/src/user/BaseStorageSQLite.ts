/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { _internals } = require('../_internals.ts');

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

  getUserIdFromUserOrUserId (userOrUserId: any): string {
    if (typeof userOrUserId === 'string') return userOrUserId;
    return userOrUserId.id;
  }

  getCollectionInfo (userOrUserId: any): { name: string | null, useUserId: string } {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return { name: this.tableName, useUserId: userId };
  }

  applyDefaults (item: any): any {
    return Object.assign({}, item);
  }

  private async userDb (userOrUserId: any): Promise<any> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, {
      withDeleted: this.hasDeletedCol,
      withHeadId: this.hasHeadIdCol
    });
    return udb;
  }

  // ---- Row ↔ item mapping ----

  rowToItem (row: any): any | null {
    if (!row) return null;
    const dataJson = row.data ? JSON.parse(row.data) : {};
    const item: any = Object.assign({}, dataJson);
    item.id = row.id;
    if (this.hasHeadIdCol && row.head_id != null) item.headId = row.head_id;
    if (this.hasDeletedCol && row.deleted != null) item.deleted = row.deleted;
    return item;
  }

  rowsToItems (rows: any[]): any[] {
    return rows.map((r) => this.rowToItem(r));
  }

  private itemToRow (item: any): { id: string, head_id: any, deleted: any, data: string } {
    const copy = Object.assign({}, item);
    const id = copy.id;
    delete copy.id;
    const head_id = this.hasHeadIdCol ? (copy.headId ?? null) : null;
    delete copy.headId;
    const deleted = this.hasDeletedCol ? (copy.deleted ?? null) : null;
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
  buildWhere (query: any): { sql: string, params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    const pushFieldOp = (lvalue: string, op: string, val: any): void => {
      conditions.push(`${lvalue} ${op} ?`);
      params.push(this.paramFor(val));
    };

    const lvalueFor = (prop: string): string => {
      if (isColColumn(prop)) return colSql(prop);
      return `json_extract(data, '$.${prop}')`;
    };

    for (const [prop, val] of Object.entries(query) as Array<[string, any]>) {
      if (prop === '$or') {
        const orParts: string[] = [];
        for (const clause of val) {
          const subConds: string[] = [];
          for (const [k, v] of Object.entries(clause) as Array<[string, any]>) {
            const lv = lvalueFor(k);
            if (v === null) {
              subConds.push(`${lv} IS NULL`);
            } else if (typeof v === 'object' && !Array.isArray(v) && v !== null) {
              this.translateOps(lv, v, subConds, params);
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
        this.translateOps(lv, val, conditions, params);
      } else {
        pushFieldOp(lv, '=', val);
      }
    }

    const sql = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { sql, params };
  }

  private translateOps (lvalue: string, val: any, conds: string[], params: any[]): void {
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

  private paramFor (val: any): any {
    if (val === undefined) return null;
    if (val instanceof Date) return val.getTime();
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  }

  // ---- Defaults injection ----

  private addImplicitFilters (query: any): any {
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
  private applyProjection (items: any[], options: any): any[] {
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

  find (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any[]) => void): void {
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

  findIncludingDeletionsAndVersions (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any[]) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const orderBy = this.buildOrderBy(options);
      const { clause: lim } = this.buildLimitOffset(options);
      const sql = `SELECT * FROM ${this.tableName} ${where} ${orderBy}${lim}`.trim();
      const rows = udb.db.prepare(sql).all(...params);
      callback(null, this.applyProjection(this.rowsToItems(rows), options));
    });
  }

  findOne (userOrUserId: any, query: any, options: any, callback: (err: any, item?: any) => void): void {
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

  findDeletion (userOrUserId: any, query: any, _options: any, callback: (err: any, item?: any) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = Object.assign({}, query || {}, { deleted: { $ne: null } });
      const { sql: where, params } = this.buildWhere(q);
      const sql = `SELECT * FROM ${this.tableName} ${where} LIMIT 1`.trim();
      const row = udb.db.prepare(sql).get(...params);
      callback(null, row ? this.rowToItem(row) : null);
    });
  }

  findDeletions (userOrUserId: any, deletedSince: number, options: any, callback: (err: any, items?: any[]) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q: any = { deleted: { $gt: deletedSince } };
      if (this.hasHeadIdCol) q.headId = null;
      const { sql: where, params } = this.buildWhere(q);
      const orderBy = this.buildOrderBy(options);
      const { clause: lim } = this.buildLimitOffset(options);
      const sql = `SELECT * FROM ${this.tableName} ${where} ${orderBy}${lim}`.trim();
      const rows = udb.db.prepare(sql).all(...params);
      callback(null, this.rowsToItems(rows));
    });
  }

  insertOne (userOrUserId: any, item: any, callback: (err: any, item?: any) => void): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const prepared = this.applyDefaults(item);
      const { id, head_id, deleted, data } = this.itemToRow(prepared);
      const cols: string[] = ['id'];
      const placeholders: string[] = ['?'];
      const vals: any[] = [id];
      if (this.hasHeadIdCol) { cols.push('head_id'); placeholders.push('?'); vals.push(head_id); }
      if (this.hasDeletedCol) { cols.push('deleted'); placeholders.push('?'); vals.push(deleted); }
      cols.push('data'); placeholders.push('?'); vals.push(data);

      udb.db.prepare(`INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`)
        .run(...vals);

      const row = udb.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id);
      return this.rowToItem(row);
    });
  }

  findOneAndUpdate (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
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

  updateOne (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
    this.findOneAndUpdate(userOrUserId, query, updatedData, callback);
  }

  updateMany (userOrUserId: any, query: any, updatedData: any, callback: (err: any, res?: any) => void): void {
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

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    const now = require('unix-timestamp').now();
    this.updateMany(userOrUserId, query, { $set: { deleted: now } }, callback);
  }

  removeOne (userOrUserId: any, query: any, callback: (err: any, count?: number) => void): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const row = udb.db.prepare(`SELECT id FROM ${this.tableName} ${where} LIMIT 1`).get(...params);
      if (!row) return 0;
      udb.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(row.id);
      return 1;
    });
  }

  removeMany (userOrUserId: any, query: any, callback: (err: any, count?: number) => void): void {
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const { sql: where, params } = this.buildWhere(query || {});
      const res = udb.db.prepare(`DELETE FROM ${this.tableName} ${where}`).run(...params);
      return res.changes;
    });
  }

  removeAll (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeMany(userOrUserId, {}, callback);
  }

  count (userOrUserId: any, query: any, callback: (err: any, n?: number) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const q = this.addImplicitFilters(query || {});
      const { sql: where, params } = this.buildWhere(q);
      const row = udb.db.prepare(`SELECT COUNT(*) AS cnt FROM ${this.tableName} ${where}`).get(...params);
      callback(null, row.cnt);
    });
  }

  countAll (userOrUserId: any, callback: (err: any, n?: number) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const row = udb.db.prepare(`SELECT COUNT(*) AS cnt FROM ${this.tableName}`).get();
      callback(null, row.cnt);
    });
  }

  async * iterateAll (): AsyncGenerator<any> {
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

  exportAll (userOrUserId: any, callback: (err: any, items?: any[]) => void): void {
    this._userDbAnd(userOrUserId, callback, (udb) => {
      const rows = udb.db.prepare(`SELECT * FROM ${this.tableName}`).all();
      callback(null, this.rowsToItems(rows));
    });
  }

  importAll (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    if (!items || items.length === 0) return callback(null);
    this._userDbAndWrite(userOrUserId, callback, (udb) => {
      const cols: string[] = ['id'];
      const placeholders: string[] = ['?'];
      if (this.hasHeadIdCol) { cols.push('head_id'); placeholders.push('?'); }
      if (this.hasDeletedCol) { cols.push('deleted'); placeholders.push('?'); }
      cols.push('data'); placeholders.push('?');
      const stmt = udb.db.prepare(`INSERT OR IGNORE INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`);
      const tx = udb.db.transaction((arr: any[]) => {
        for (const it of arr) {
          const row = this.itemToRow(this.applyDefaults(it));
          const vals: any[] = [row.id];
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

  clearAll (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeAll(userOrUserId, callback);
  }

  // ---- Update merging ----

  private applyUpdateToItem (item: any, updatedData: any): any {
    const merged = Object.assign({}, item);
    const $set = updatedData.$set || {};
    const $unset = updatedData.$unset || {};
    const $inc = updatedData.$inc || {};
    const $min = updatedData.$min || {};
    const $max = updatedData.$max || {};

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
        const mergedField: any = Object.assign({}, existing);
        for (const [subKey, subVal] of Object.entries(v as Record<string, any>)) {
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
    for (const [k, v] of Object.entries($inc) as Array<[string, number]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, (typeof cur === 'number' ? cur : 0) + v);
    }
    for (const [k, v] of Object.entries($min) as Array<[string, any]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, cur == null ? v : Math.min(cur, v));
    }
    for (const [k, v] of Object.entries($max) as Array<[string, any]>) {
      const cur = this.getNested(merged, k);
      this.setNested(merged, k, cur == null ? v : Math.max(cur, v));
    }

    return merged;
  }

  private setNested (obj: any, path: string, val: any): void {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }

  private unsetNested (obj: any, path: string): void {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) return;
      cur = cur[parts[i]];
    }
    delete cur[parts[parts.length - 1]];
  }

  private getNested (obj: any, path: string): any {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  private _writeMerged (udb: any, id: string, merged: any): void {
    const row = this.itemToRow(Object.assign({}, merged, { id }));
    const cols: string[] = [];
    const vals: any[] = [];
    if (this.hasHeadIdCol) { cols.push('head_id = ?'); vals.push(row.head_id); }
    if (this.hasDeletedCol) { cols.push('deleted = ?'); vals.push(row.deleted); }
    cols.push('data = ?'); vals.push(row.data);
    vals.push(id);
    udb.db.prepare(`UPDATE ${this.tableName} SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ---- Order/limit ----

  buildOrderBy (options: any): string {
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

  buildLimitOffset (options: any): { clause: string } {
    let clause = '';
    if (options?.limit) clause += ` LIMIT ${Number(options.limit)}`;
    if (options?.skip) {
      if (!options?.limit) clause += ' LIMIT -1';
      clause += ` OFFSET ${Number(options.skip)}`;
    }
    return { clause };
  }

  // ---- Test/extra helpers ----

  findAll (userOrUserId: any, options: any, callback: (err: any, items?: any[]) => void): void {
    // Mirror PG's findAll: do NOT apply implicit filters (deleted=null,
    // headId=null), so the result includes deleted + versioned rows.
    // Used by test fixtures (`accesses-app.test.js` etc.) to assert on
    // deletion-tombstone state after a soft-delete.
    this.findIncludingDeletionsAndVersions(userOrUserId, {}, options, callback);
  }

  insertMany (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    this.importAll(userOrUserId, items, callback);
  }

  dropCollection (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeAll(userOrUserId, callback);
  }

  dropCollectionFully (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeAll(userOrUserId, callback);
  }

  listIndexes (_userOrUserId: any, _options: any, callback: (err: any, indexes?: any[]) => void): void {
    callback(null, []);
  }

  findAndUpdateIfNeeded (userOrUserId: any, query: any, options: any, updateIfNeededCallback: (item: any) => any, callback: (err: any, res?: any) => void): void {
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

  private _userDbAnd (userOrUserId: any, callback: any, fn: (udb: any) => void): void {
    this.userDb(userOrUserId)
      .then((udb) => {
        try { fn(udb); } catch (err) { callback(err); }
      })
      .catch(callback);
  }

  private _userDbAndWrite (userOrUserId: any, callback: any, fn: (udb: any) => any): void {
    this.userDb(userOrUserId)
      .then(async (udb) => {
        try {
          let result: any;
          await concurrentSafeWrite.execute(() => { result = fn(udb); });
          callback(null, result);
        } catch (err) { callback(err); }
      })
      .catch(callback);
  }
}

export { BaseStorageSQLite };
