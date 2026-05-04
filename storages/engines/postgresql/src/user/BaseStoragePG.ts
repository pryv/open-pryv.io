/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const DatabasePG = require('../DatabasePG');

/**
 * Column-name mapping: camelCase JS property → snake_case PG column.
 */
const DEFAULT_COLUMN_MAP: Record<string, string> = {
  parentId: 'parent_id',
  clientData: 'client_data',
  singleActivity: 'single_activity',
  headId: 'head_id',
  endTime: 'end_time',
  createdBy: 'created_by',
  modifiedBy: 'modified_by',
  accessId: 'access_id',
  deviceName: 'device_name',
  runCount: 'run_count',
  failCount: 'fail_count',
  lastRun: 'last_run',
  currentRetries: 'current_retries',
  maxRetries: 'max_retries',
  minIntervalMs: 'min_interval_ms',
  accessToken: 'access_token',
  streamId: 'stream_id',
  profileId: 'profile_id',
  integrityBatchCode: 'integrity_batch_code',
  lastUsed: 'last_used',
  streamIds: 'stream_ids'
};

/**
 * Columns where null is meaningful and should be preserved in the API response.
 * In MongoDB, unset fields are absent from documents. In PG, all columns exist
 * with null defaults. We only preserve null for these API-facing nullable fields.
 */
const NULLABLE_COLUMNS = new Set([
  'trashed', 'parent_id', 'description', 'end_time',
  'head_id', 'deleted'
]);

/**
 * Columns stored as JSONB in PG and needing JSON.stringify on write / parse on read.
 */
const DEFAULT_JSONB_COLUMNS = new Set([
  'client_data', 'content', 'attachments', 'permissions',
  'last_run', 'runs', 'data', 'calls', 'tags', 'stream_ids'
]);

/**
 * Base class for PostgreSQL user-scoped storage.
 * Provides the same callback-based API as BaseStorage (MongoDB) so that
 * StorageLayer consumers see a uniform interface.
 *
 * Subclasses must set:
 *   this.tableName      — PG table name
 *   this.columnMap      — (optional) additional camelCase→snake_case overrides
 *   this.jsonbColumns   — (optional) additional Set of snake_case JSONB column names
 *   this.idField        — (optional) if the public 'id' maps to a different column (e.g. 'stream_id')
 *   this.defaultSort    — (optional) default ORDER BY clause
 *   this.hasDeletedCol  — (optional, default true) whether table has a `deleted` column
 *   this.hasHeadIdCol   — (optional, default false) whether table has a `head_id` column
 */
class BaseStoragePG {
  db: any;
  tableName: string | null;
  columnMap: Record<string, string>;
  jsonbColumns: Set<string>;
  idField: string;
  defaultSort: string | null;
  hasDeletedCol: boolean;
  hasHeadIdCol: boolean;

  constructor (db: any) {
    this.db = db;
    this.tableName = null;
    this.columnMap = {};
    this.jsonbColumns = new Set();
    this.idField = 'id';
    this.defaultSort = null;
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
  }

  getUserIdFromUserOrUserId (userOrUserId: any): string {
    if (typeof userOrUserId === 'string') return userOrUserId;
    return userOrUserId.id;
  }

  getCollectionInfo (userOrUserId: any): { name: string | null, useUserId: string } {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return { name: this.tableName, useUserId: userId };
  }

  // ---- Column mapping helpers ----

  toCol (prop: string): string {
    if (prop === 'id' || prop === '_id') return this.idField;
    return this.columnMap[prop] || DEFAULT_COLUMN_MAP[prop] || prop;
  }

  fromCol (col: string): string {
    if (col === this.idField && this.idField !== 'id') return 'id';
    for (const [k, v] of Object.entries(this.columnMap)) {
      if (v === col) return k;
    }
    for (const [k, v] of Object.entries(DEFAULT_COLUMN_MAP)) {
      if (v === col) return k;
    }
    return col;
  }

  isJsonbCol (snakeCol: string): boolean {
    return DEFAULT_JSONB_COLUMNS.has(snakeCol) || this.jsonbColumns.has(snakeCol);
  }

  toPGValue (snakeCol: string, value: any): any {
    if (value === undefined) return null;
    if (this.isJsonbCol(snakeCol) && value != null) {
      return JSON.stringify(value);
    }
    return value;
  }

  rowToItem (row: any): any | null {
    if (!row) return null;
    const item: any = {};
    for (const [col, val] of Object.entries(row)) {
      if (col === 'user_id') continue;
      if (val === null && !NULLABLE_COLUMNS.has(col)) continue;
      const prop = this.fromCol(col);
      item[prop] = val;
    }
    if (this.hasDeletedCol && item.deleted == null) {
      delete item.deleted;
    }
    return item;
  }

  rowsToItems (rows: any[]): any[] {
    return rows.map((r) => this.rowToItem(r));
  }

  // ---- Query building helpers ----

  buildWhere (userId: string, query: any, startIdx: number = 1): { text: string, params: any[], nextIdx: number } {
    const conditions: string[] = [`user_id = $${startIdx}`];
    const params: any[] = [userId];
    let idx = startIdx + 1;

    for (const [prop, val] of Object.entries(query) as Array<[string, any]>) {
      if (prop === '$or') {
        const orParts: string[] = [];
        for (const clause of val) {
          const sub: string[] = [];
          for (const [k, v] of Object.entries(clause) as Array<[string, any]>) {
            const col = this.toCol(k);
            if (v === null) {
              sub.push(`${col} IS NULL`);
            } else {
              sub.push(`${col} = $${idx}`);
              params.push(this.toPGValue(col, v));
              idx++;
            }
          }
          orParts.push('(' + sub.join(' AND ') + ')');
        }
        conditions.push('(' + orParts.join(' OR ') + ')');
        continue;
      }

      const col = this.toCol(prop);

      if (val === null) {
        conditions.push(`${col} IS NULL`);
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        // MongoDB-style operators
        if (val.$eq !== undefined) {
          if (val.$eq === null) {
            conditions.push(`${col} IS NULL`);
          } else {
            conditions.push(`${col} = $${idx}`);
            params.push(this.toPGValue(col, val.$eq));
            idx++;
          }
        }
        if (val.$gt !== undefined) {
          conditions.push(`${col} > $${idx}`);
          params.push(val.$gt);
          idx++;
        }
        if (val.$gte !== undefined) {
          conditions.push(`${col} >= $${idx}`);
          params.push(val.$gte);
          idx++;
        }
        if (val.$lt !== undefined) {
          conditions.push(`${col} < $${idx}`);
          params.push(val.$lt);
          idx++;
        }
        if (val.$lte !== undefined) {
          conditions.push(`${col} <= $${idx}`);
          params.push(val.$lte);
          idx++;
        }
        if (val.$ne !== undefined) {
          if (val.$ne === null) {
            conditions.push(`${col} IS NOT NULL`);
          } else {
            conditions.push(`${col} != $${idx}`);
            params.push(val.$ne);
            idx++;
          }
        }
        if (val.$in !== undefined) {
          const placeholders = val.$in.map(() => `$${idx++}`);
          conditions.push(`${col} IN (${(placeholders as string[]).join(', ')})`);
          params.push(...val.$in);
        }
        if (val.$type !== undefined) {
          // $type: 'number' means IS NOT NULL (for numeric fields)
          // $type: 'null' means IS NULL
          if (val.$type === 'number') {
            conditions.push(`${col} IS NOT NULL`);
          } else if (val.$type === 'null') {
            conditions.push(`${col} IS NULL`);
          }
        }
      } else {
        conditions.push(`${col} = $${idx}`);
        params.push(this.toPGValue(col, val));
        idx++;
      }
    }

    return {
      text: 'WHERE ' + conditions.join(' AND '),
      params,
      nextIdx: idx
    };
  }

  buildOrderBy (options: any): string {
    const sort = options?.sort;
    if (sort && Object.keys(sort).length > 0) {
      const parts = Object.entries(sort).map(([k, v]) => {
        return `${this.toCol(k)} ${v === -1 ? 'DESC' : 'ASC'}`;
      });
      return 'ORDER BY ' + parts.join(', ');
    }
    if (this.defaultSort) return 'ORDER BY ' + this.defaultSort;
    return '';
  }

  buildLimitOffset (options: any, params: any[], nextIdx: number): { clause: string, nextIdx: number } {
    let clause = '';
    if (options?.limit) {
      clause += ` LIMIT $${nextIdx}`;
      params.push(options.limit);
      nextIdx++;
    }
    if (options?.skip) {
      clause += ` OFFSET $${nextIdx}`;
      params.push(options.skip);
      nextIdx++;
    }
    return { clause, nextIdx };
  }

  buildSelect (options: any): { select: string, excludeProps: string[] } {
    if (options?.projection && Object.keys(options.projection).length > 0) {
      const entries = Object.entries(options.projection);
      const isNegative = entries.every(([, v]) => !v);
      if (isNegative) {
        const excludeProps = entries.map(([k]) => k);
        return { select: '*', excludeProps };
      }
      const cols = ['user_id'];
      for (const [k, v] of entries) {
        if (v) cols.push(this.toCol(k));
      }
      return { select: cols.join(', '), excludeProps: [] };
    }
    return { select: '*', excludeProps: [] };
  }

  applyExclusions (items: any[], excludeProps: string[]): any[] {
    if (!excludeProps || excludeProps.length === 0) return items;
    for (const item of items) {
      for (const prop of excludeProps) {
        delete item[prop];
      }
    }
    return items;
  }

  // ---- Core CRUD methods (callback-based) ----

  find (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (this.hasDeletedCol) query.deleted = null;
    if (this.hasHeadIdCol) query.headId = null;
    this._findInternal(userId, query, options, callback);
  }

  findIncludingDeletionsAndVersions (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this._findInternal(userId, query, options, callback);
  }

  _findInternal (userId: string, query: any, options: any, callback: (err: any, items?: any) => void): void {
    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);
    const orderBy = this.buildOrderBy(options);
    const { clause: limitOffset } = this.buildLimitOffset(options, where.params, where.nextIdx);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} ${orderBy}${limitOffset}`;
    this.db.query(sql, where.params)
      .then((res: any) => callback(null, this.applyExclusions(this.rowsToItems(res.rows), excludeProps)))
      .catch(callback);
  }

  findOne (userOrUserId: any, query: any, options: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (this.hasDeletedCol) query.deleted = null;

    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} LIMIT 1`;
    this.db.query(sql, where.params)
      .then((res: any) => {
        if (res.rows.length === 0) return callback(null, null);
        const item = this.rowToItem(res.rows[0]);
        this.applyExclusions([item], excludeProps);
        callback(null, item);
      })
      .catch(callback);
  }

  findDeletion (userOrUserId: any, query: any, options: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    query.deleted = { $ne: null };

    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} LIMIT 1`;
    this.db.query(sql, where.params)
      .then((res: any) => {
        if (res.rows.length === 0) return callback(null, null);
        const item = this.rowToItem(res.rows[0]);
        this.applyExclusions([item], excludeProps);
        callback(null, item);
      })
      .catch(callback);
  }

  findDeletions (userOrUserId: any, deletedSince: number, options: any, callback: (err: any, items?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const query: any = { deleted: { $gt: deletedSince } };
    if (this.hasHeadIdCol) query.headId = null;
    this._findInternal(userId, query, options, callback);
  }

  insertOne (userOrUserId: any, item: any, callback: (err: any, item?: any) => void, _options?: any): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    item = this.applyDefaults(item);

    const cols: string[] = ['user_id'];
    const vals: any[] = [userId];
    const placeholders: string[] = ['$1'];
    let idx = 2;

    for (const [prop, val] of Object.entries(item)) {
      if (prop === 'id') {
        cols.push(this.idField);
      } else {
        cols.push(this.toCol(prop));
      }
      const colName = prop === 'id' ? this.idField : this.toCol(prop);
      vals.push(this.toPGValue(colName, val));
      placeholders.push(`$${idx}`);
      idx++;
    }

    const sql = `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    this.db.query(sql, vals)
      .then((res: any) => callback(null, this.rowToItem(res.rows[0])))
      .catch((err: any) => {
        DatabasePG.handleDuplicateError(err);
        callback(err);
      });
  }

  findOneAndUpdate (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const { setClauses, unsetClauses, incClauses, params, nextIdx } =
      this._buildUpdateClauses(updatedData, 1);

    const allClauses = [...setClauses, ...unsetClauses, ...incClauses];
    if (allClauses.length === 0) {
      return this.findOne(userOrUserId, query, null, callback);
    }

    const where = this.buildWhere(userId, query, nextIdx);

    const sql = `UPDATE ${this.tableName} SET ${allClauses.join(', ')} ${where.text} RETURNING *`;
    const allParams = [...params, ...where.params];

    this.db.query(sql, allParams)
      .then((res: any) => {
        callback(null, res.rows.length > 0 ? this.rowToItem(res.rows[0]) : null);
      })
      .catch((err: any) => {
        DatabasePG.handleDuplicateError(err);
        callback(err);
      });
  }

  updateOne (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
    this.findOneAndUpdate(userOrUserId, query, updatedData, callback);
  }

  updateMany (userOrUserId: any, query: any, updatedData: any, callback: (err: any, res?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const { setClauses, unsetClauses, incClauses, params, nextIdx } =
      this._buildUpdateClauses(updatedData, 1);

    const allClauses = [...setClauses, ...unsetClauses, ...incClauses];
    if (allClauses.length === 0) return callback(null, { modifiedCount: 0 });

    const where = this.buildWhere(userId, query, nextIdx);

    const sql = `UPDATE ${this.tableName} SET ${allClauses.join(', ')} ${where.text}`;
    const allParams = [...params, ...where.params];

    this.db.query(sql, allParams)
      .then((res: any) => callback(null, { modifiedCount: res.rowCount }))
      .catch(callback);
  }

  _buildUpdateClauses (updatedData: any, startIdx: number): { setClauses: string[], unsetClauses: string[], incClauses: string[], params: any[], nextIdx: number } {
    const input: any = Object.assign({}, updatedData);
    const setClauses: string[] = [];
    const unsetClauses: string[] = [];
    const incClauses: string[] = [];
    const params: any[] = [];
    let idx = startIdx;

    // Extract MongoDB operators
    const $set = input.$set || {};
    delete input.$set;
    const $unset = input.$unset || {};
    delete input.$unset;
    const $inc = input.$inc || {};
    delete input.$inc;
    const $min = input.$min || {};
    delete input.$min;
    const $max = input.$max || {};
    delete input.$max;
    delete input.$pull; // Not supported in PG — handle in subclass if needed

    // Remaining plain properties are treated as $set
    for (const [k, v] of Object.entries(input)) {
      if (!k.startsWith('$')) {
        $set[k] = v;
      }
    }

    // Auto-expand JSONB column objects to dot-notation for merge semantics.
    // When $set has a key that maps to a JSONB column and the value is a plain object,
    // expand it: { data: { keyOne: 'val', keyTwo: null } } → { 'data.keyOne': 'val' } + $unset { 'data.keyTwo': 1 }
    // This replicates the MongoDB converter getKeyValueSetUpdateFn behavior.
    for (const [k, v] of Object.entries($set)) {
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        const snakeCol = this.toCol(k);
        if (this.isJsonbCol(snakeCol)) {
          for (const [subKey, subVal] of Object.entries(v)) {
            if (subVal !== null) {
              $set[`${k}.${subKey}`] = subVal;
            } else {
              $unset[`${k}.${subKey}`] = 1;
            }
          }
          delete $set[k];
        }
      }
    }

    // Handle key-value set updates (e.g., clientData.key = val or data.key = val)
    // These come from converters.getKeyValueSetUpdateFn and appear as dot-notation keys
    const dotSetKeys = Object.keys($set).filter((k) => k.includes('.'));
    const dotUnsetKeys = Object.keys($unset).filter((k) => k.includes('.'));

    if (dotSetKeys.length > 0 || dotUnsetKeys.length > 0) {
      const jsonbUpdates: Record<string, Record<string, any>> = {};
      for (const key of dotSetKeys) {
        const [col, ...rest] = key.split('.');
        const snakeCol = this.toCol(col);
        if (!jsonbUpdates[snakeCol]) jsonbUpdates[snakeCol] = {};
        jsonbUpdates[snakeCol][rest.join('.')] = $set[key];
        delete $set[key];
      }
      for (const key of dotUnsetKeys) {
        const [col, ...rest] = key.split('.');
        const snakeCol = this.toCol(col);
        if (!jsonbUpdates[snakeCol]) jsonbUpdates[snakeCol] = {};
        jsonbUpdates[snakeCol][rest.join('.')] = null;
        delete $unset[key];
      }

      for (const [snakeCol, updates] of Object.entries(jsonbUpdates)) {
        const keysToSet: Record<string, any> = {};
        const keysToRemove: string[] = [];
        for (const [k, v] of Object.entries(updates)) {
          if (v === null) {
            keysToRemove.push(k);
          } else {
            keysToSet[k] = v;
          }
        }
        let expr = `COALESCE(${snakeCol}, '{}'::jsonb)`;
        if (Object.keys(keysToSet).length > 0) {
          // Parenthesize so `-` (key removal) applies to the merged result,
          // not just the new data. PG's `-` binds tighter than `||`.
          expr = `(${expr} || $${idx}::jsonb)`;
          params.push(JSON.stringify(keysToSet));
          idx++;
        }
        for (const key of keysToRemove) {
          expr = `${expr} - $${idx}`;
          params.push(key);
          idx++;
        }
        setClauses.push(`${snakeCol} = ${expr}`);
      }
    }

    // $set (plain properties)
    for (const [k, v] of Object.entries($set)) {
      if (k.includes('.')) continue; // already handled
      const col = this.toCol(k);
      setClauses.push(`${col} = $${idx}`);
      params.push(this.toPGValue(col, v));
      idx++;
    }

    // $unset (set to NULL)
    for (const k of Object.keys($unset)) {
      if (k.includes('.')) continue; // already handled
      const col = this.toCol(k);
      unsetClauses.push(`${col} = NULL`);
    }

    // $inc — group dotted-path entries by topKey so multiple JSONB-path
    // increments on the same column produce ONE nested jsonb_set clause.
    // Postgres rejects `SET col = …, col = …` ("multiple assignments to same
    // column"), which is exactly what batched API calls produce when
    // accessTracking is on (e.g. $inc: { 'calls.events:get': 1, 'calls.accesses:get': 1 }).
    const dottedByTopKey: Record<string, Array<[string, any]>> = {};
    const bareInc: Array<[string, any]> = [];
    for (const [k, v] of Object.entries($inc)) {
      if (k.includes('.')) {
        const [topKey, ...rest] = k.split('.');
        if (dottedByTopKey[topKey] == null) dottedByTopKey[topKey] = [];
        dottedByTopKey[topKey].push([rest.join('.'), v]);
      } else {
        bareInc.push([k, v]);
      }
    }
    for (const [topKey, entries] of Object.entries(dottedByTopKey)) {
      const snakeCol = this.toCol(topKey);
      // Nest jsonb_set: each call wraps the previous expression. Each one reads
      // (snakeCol->>$key) from the ORIGINAL column (not the partially-built
      // expression) — preserves Mongo $inc disjoint-paths semantics.
      let expr = `COALESCE(${snakeCol}, '{}'::jsonb)`;
      for (const [jsonbKey, v] of entries) {
        expr =
          `jsonb_set(${expr}, ARRAY[$${idx}]::text[], ` +
          `to_jsonb(COALESCE((${snakeCol}->>$${idx})::numeric, 0) + $${idx + 1}))`;
        params.push(jsonbKey, v);
        idx += 2;
      }
      incClauses.push(`${snakeCol} = ${expr}`);
    }
    for (const [k, v] of bareInc) {
      const col = this.toCol(k);
      incClauses.push(`${col} = COALESCE(${col}, 0) + $${idx}`);
      params.push(v);
      idx++;
    }

    // $min
    for (const [k, v] of Object.entries($min)) {
      const col = this.toCol(k);
      setClauses.push(`${col} = LEAST(${col}, $${idx})`);
      params.push(v);
      idx++;
    }

    // $max
    for (const [k, v] of Object.entries($max)) {
      const col = this.toCol(k);
      setClauses.push(`${col} = GREATEST(${col}, $${idx})`);
      params.push(v);
      idx++;
    }

    return { setClauses, unsetClauses, incClauses, params, nextIdx: idx };
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    this.updateMany(userOrUserId, query, { $set: { deleted: require('unix-timestamp').now() } }, callback);
  }

  removeOne (userOrUserId: any, query: any, callback: (err: any, count?: number) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const where = this.buildWhere(userId, query);

    const sql = `DELETE FROM ${this.tableName} WHERE ctid IN (SELECT ctid FROM ${this.tableName} ${where.text} LIMIT 1)`;
    this.db.query(sql, where.params)
      .then((res: any) => callback(null, res.rowCount))
      .catch(callback);
  }

  removeMany (userOrUserId: any, query: any, callback: (err: any, count?: number) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const where = this.buildWhere(userId, query);

    const sql = `DELETE FROM ${this.tableName} ${where.text}`;
    this.db.query(sql, where.params)
      .then((res: any) => callback(null, res.rowCount))
      .catch(callback);
  }

  removeAll (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeMany(userOrUserId, {}, callback);
  }

  count (userOrUserId: any, query: any, callback: (err: any, n?: number) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (this.hasDeletedCol) query.deleted = null;
    if (this.hasHeadIdCol) query.headId = null;

    const where = this.buildWhere(userId, query);
    const sql = `SELECT COUNT(*)::int AS cnt FROM ${this.tableName} ${where.text}`;
    this.db.query(sql, where.params)
      .then((res: any) => callback(null, res.rows[0].cnt))
      .catch(callback);
  }

  countAll (userOrUserId: any, callback: (err: any, n?: number) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const sql = `SELECT COUNT(*)::int AS cnt FROM ${this.tableName} WHERE user_id = $1`;
    this.db.query(sql, [userId])
      .then((res: any) => callback(null, res.rows[0].cnt))
      .catch(callback);
  }

  async * iterateAll (): AsyncGenerator<any> {
    const res = await this.db.query(`SELECT * FROM ${this.tableName}`);
    for (const row of res.rows) {
      yield this.rowToItem(row);
    }
  }

  // ---- Test helpers ----

  findAll (userOrUserId: any, options: any, callback: (err: any, items?: any[]) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this._findInternal(userId, {}, options, callback);
  }

  insertMany (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (!items || items.length === 0) return callback(null);

    const doInserts = async (): Promise<void> => {
      for (const item of items) {
        const prepared = this.applyDefaults(item);
        const cols: string[] = ['user_id'];
        const vals: any[] = [userId];
        const placeholders: string[] = ['$1'];
        let idx = 2;

        for (const [prop, val] of Object.entries(prepared)) {
          const colName = prop === 'id' ? this.idField : this.toCol(prop);
          cols.push(colName);
          vals.push(this.toPGValue(colName, val));
          placeholders.push(`$${idx}`);
          idx++;
        }

        const sql = `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
        await this.db.query(sql, vals);
      }
    };

    doInserts().then(() => callback(null)).catch(callback);
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
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const where = this.buildWhere(userId, query);
    const orderBy = this.buildOrderBy(options);

    const sql = `SELECT * FROM ${this.tableName} ${where.text} ${orderBy}`;
    this.db.query(sql, where.params)
      .then(async (res: any) => {
        let updatesDone = 0;
        for (const row of res.rows) {
          const item = this.rowToItem(row);
          const updateQuery = updateIfNeededCallback(item);
          if (updateQuery == null) continue;
          await new Promise<void>((resolve, reject) => {
            this.findOneAndUpdate(userOrUserId, { id: item.id }, updateQuery,
              (err: any) => err ? reject(err) : resolve());
          });
          updatesDone++;
        }
        callback(null, { count: updatesDone });
      })
      .catch(callback);
  }

  // ---- Migration methods ----

  exportAll (userOrUserId: any, callback: (err: any, items?: any[]) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const sql = `SELECT * FROM ${this.tableName} WHERE user_id = $1`;
    this.db.query(sql, [userId])
      .then((res: any) => callback(null, this.rowsToItems(res.rows)))
      .catch(callback);
  }

  importAll (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    if (!items || items.length === 0) return callback(null);
    this.insertMany(userOrUserId, items, callback);
  }

  clearAll (userOrUserId: any, callback: (err: any, count?: number) => void): void {
    this.removeAll(userOrUserId, callback);
  }

  // ---- Defaults ----

  applyDefaults (item: any): any {
    return Object.assign({}, item);
  }
}

module.exports = BaseStoragePG;
