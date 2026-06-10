/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite implementation of the `SeriesConnection` interface
 * (see `storages/interfaces/seriesStorage/SeriesConnection.ts`).
 *
 * Architecture: per-user SQLite file at
 * `<userLocalDirectory>/<userId>/series-<version>.sqlite`. The
 * "database name" parameter on the interface is treated as the userId;
 * "measurement" is the eventId. Connection handles are cached in an
 * LRU so repeated writes to the same user don't re-open the file.
 *
 * InfluxQL parsing mirrors the PG engine's `parseInfluxSelect` so the
 * query surface stays identical across engines.
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);

const path = require('path');
const fs = require('fs/promises');
const { LRUCache: LRU } = require('lru-cache');

const { SeriesDatabase } = require('./SeriesDatabase.ts');
const { _internals } = require('../_internals.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';
const FILE_PREFIX = 'series';

type FieldsObj = Record<string, unknown>;
type SeriesPoint = Record<string, unknown> & { time?: number };
type SeriesRow = { delta_time: number; fields: string | null; [k: string]: unknown };
type InsertRow = { event_id: string; point_time: number; delta_time: number; fields: string };
type SeriesDb = {
  init (): Promise<void>;
  close (): void;
  writePoints (rows: InsertRow[]): Promise<unknown>;
  dropEvent (id: string): Promise<unknown>;
  listEventIds (): string[];
  selectRows (sql: string, params: unknown[]): SeriesRow[];
};

class SeriesConnectionSQLite {
  logger: Logger;
  cache: InstanceType<typeof LRU>;

  constructor () {
    this.logger = _internals.getLogger('sqlite-series');
    this.cache = new LRU({
      max: CACHE_SIZE,
      dispose: (db: SeriesDb) => db.close()
    });
  }

  // ----- SeriesConnection interface ---------------------------------------

  /**
   * Ensures the per-user file exists. No-op if already open.
   * "name" = userId.
   */
  async createDatabase (name: string): Promise<void> {
    this.logger.debug(`createDatabase: ${name}`);
    await this.forUser(name);
  }

  /**
   * Wipes the per-user series file entirely (Art.17 unlink). Both
   * the cached handle and the on-disk file go.
   */
  async dropDatabase (name: string): Promise<void> {
    this.logger.debug(`dropDatabase: ${name}`);
    const cached = this.cache.get(name);
    if (cached) {
      cached.close();
      this.cache.delete(name);
    }
    const dbPath = await this.pathForUser(name);
    try {
      await fs.unlink(dbPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Write points for a single measurement (eventId).
   */
  async writeMeasurement (
    measurement: string,
    points: Array<{ fields: FieldsObj, timestamp: number }>,
    options: { database: string }
  ): Promise<void> {
    if (points.length === 0) return;
    const db = await this.forUser(options.database);
    this.logger.debug(`writeMeasurement: ${measurement} (${points.length} points)`);
    const rows = points.map(p => toRow(measurement, p));
    await db.writePoints(rows);
  }

  /**
   * Write points across potentially multiple measurements.
   */
  async writePoints (
    points: Array<{ measurement: string, fields: FieldsObj, timestamp: number }>,
    options: { database: string }
  ): Promise<void> {
    if (points.length === 0) return;
    const db = await this.forUser(options.database);
    this.logger.debug(`writePoints: ${points.length} points`);
    const rows = points.map(p => toRow(p.measurement, p));
    await db.writePoints(rows);
  }

  /**
   * Drop one measurement (eventId) from the user's file.
   */
  async dropMeasurement (measurement: string, dbName: string): Promise<void> {
    this.logger.debug(`dropMeasurement: ${measurement} on ${dbName}`);
    const db = await this.forUser(dbName);
    await db.dropEvent(measurement);
  }

  /**
   * Run a (simplified) InfluxQL query against the user's file.
   * Supports `SHOW MEASUREMENTS` and `SELECT * FROM "<event>" [WHERE time <cmp> 'ts']`.
   */
  async query (queryStr: string, options: { database: string }): Promise<SeriesPoint[]> {
    const userId = options.database;
    const singleLine = queryStr.replace(/\s+/g, ' ').trim();
    this.logger.debug(`query: ${singleLine}`);

    const db = await this.forUser(userId);

    if (/^SHOW\s+MEASUREMENTS$/i.test(singleLine)) {
      return db.listEventIds().map((id: string) => ({ name: id }));
    }

    const parsed = parseInfluxSelect(singleLine);
    if (!parsed) {
      throw new Error(`SeriesConnectionSQLite: unsupported query: ${singleLine}`);
    }

    const conditions: string[] = ['event_id = ?'];
    const params: unknown[] = [parsed.measurement];
    for (const cond of parsed.conditions) {
      if (cond.op === '>=' || cond.op === '<' || cond.op === '>' || cond.op === '<=') {
        conditions.push(`delta_time ${cond.op} ?`);
        params.push(cond.value);
      }
    }

    const sql = `SELECT delta_time, fields FROM series_data WHERE ${conditions.join(' AND ')} ORDER BY delta_time ASC`;
    const rows = db.selectRows(sql, params);

    return rows.map((row: SeriesRow) => {
      const result: SeriesPoint = { time: row.delta_time / 1e6 };
      const parsedFields = row.fields ? JSON.parse(row.fields) : null;
      if (parsedFields && typeof parsedFields === 'object') Object.assign(result, parsedFields);
      return result;
    });
  }

  /**
   * List user IDs that have a series file on disk.
   * Implemented via filesystem scan of `<userLocalDirectory>` so the
   * answer reflects committed state, not just currently-cached handles.
   */
  async getDatabases (): Promise<string[]> {
    const base = await getUsersBaseDir();
    const userIds: string[] = [];
    try {
      const entries = await collectUserIdsWithSeriesFile(base);
      userIds.push(...entries);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return userIds;
  }

  // ----- Backup / restore -------------------------------------------------

  async exportDatabase (name: string): Promise<{ measurements: Array<{ measurement: string, points: SeriesPoint[] }> }> {
    const db = await this.forUser(name);
    const eventIds = db.listEventIds();
    const measurements: Array<{ measurement: string, points: SeriesPoint[] }> = [];
    for (const eventId of eventIds) {
      const rows = db.selectRows(
        'SELECT delta_time, fields FROM series_data WHERE event_id = ? ORDER BY delta_time ASC',
        [eventId]
      );
      const points = rows.map((r: SeriesRow) => {
        const point: SeriesPoint = { time: r.delta_time / 1e6 };
        const parsedFields = r.fields ? JSON.parse(r.fields) : null;
        if (parsedFields && typeof parsedFields === 'object') Object.assign(point, parsedFields);
        return point;
      });
      measurements.push({ measurement: eventId, points });
    }
    return { measurements };
  }

  async importDatabase (
    name: string,
    data: { measurements: Array<{ measurement: string, points: SeriesPoint[] }> }
  ): Promise<void> {
    await this.createDatabase(name);
    const db = await this.forUser(name);
    for (const { measurement, points } of data.measurements) {
      if (!points || points.length === 0) continue;
      const rows = points.map((p: SeriesPoint) => {
        const fields: FieldsObj = {};
        const tags: FieldsObj = {};
        for (const [key, value] of Object.entries(p)) {
          if (key === 'time') continue;
          if (typeof value === 'string') tags[key] = value;
          else fields[key] = value;
        }
        const allFields = Object.assign({}, fields, tags);
        const deltaTime = typeof p.time === 'number' ? p.time * 1e6 : Number(p.time) * 1e6;
        return {
          event_id: measurement,
          point_time: deltaTime,
          delta_time: deltaTime,
          fields: JSON.stringify(allFields)
        };
      });
      await db.writePoints(rows);
    }
  }

  // ----- per-user-file dispatch -------------------------------------------

  /**
   * Open (or return cached) SeriesDatabase for the given userId.
   */
  async forUser (userId: string): Promise<SeriesDb> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const dbPath = await this.pathForUser(userId);
    const db = new SeriesDatabase(this.logger, { dbPath });
    await db.init();
    this.cache.set(userId, db);
    return db;
  }

  async pathForUser (userId: string): Promise<string> {
    const userPath = await _internals.userLocalDirectory.ensureUserDirectory(userId);
    return path.join(userPath, `${FILE_PREFIX}-${VERSION}.sqlite`);
  }
}

/**
 * Build the `series_data` row shape from a SeriesConnection point.
 *
 * `timestamp` is in nanoseconds (callers from `series.ts` multiply
 * `deltaTime * 1e6` before calling). We store both `point_time` and
 * `delta_time` set to that nanosecond value, matching the PG schema's
 * "point_time = delta_time" convention for the SQLite-as-Influx case.
 */
function toRow (eventId: string, point: { fields: FieldsObj, timestamp: number }): InsertRow {
  const tsNs = typeof point.timestamp === 'number' ? point.timestamp : Number(point.timestamp);
  return {
    event_id: eventId,
    point_time: tsNs,
    delta_time: tsNs,
    fields: JSON.stringify(point.fields)
  };
}

/**
 * Parse a simple InfluxQL SELECT (matches PGSeriesConnection.parseInfluxSelect).
 */
function parseInfluxSelect (query: string): { measurement: string, conditions: Array<{ op: string, value: number }> } | null {
  const fromMatch = query.match(/FROM\s+"?([^"\s]+)"?/i);
  if (!fromMatch) return null;

  const measurement = fromMatch[1];
  const conditions: Array<{ op: string, value: number }> = [];

  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+ORDER|\s*$)/i);
  if (whereMatch) {
    const whereStr = whereMatch[1];
    const timeRegex = /time\s*(>=|<=|>|<)\s*'([^']+)'/g;
    let match;
    while ((match = timeRegex.exec(whereStr)) !== null) {
      // Match PG: InfluxQL literals have no TZ marker but are UTC. Force
      // 'Z' so JS parses as UTC; otherwise non-UTC dev machines would
      // silently produce empty result rows.
      const dateMs = new Date(match[2] + 'Z').getTime();
      const nanoSecs = dateMs * 1e6;
      conditions.push({ op: match[1], value: nanoSecs });
    }
  }

  return { measurement, conditions };
}

async function getUsersBaseDir (): Promise<string> {
  // userLocalDirectory exposes `getBase()` returning the configured root,
  // or computes it from `<sqlite.path>/users` if absent. We use the
  // path manager's basePath getter when available; otherwise fall back
  // to scanning under the configured sqlite path.
  const uld = _internals.userLocalDirectory;
  if (typeof uld.getBasePath === 'function') return uld.getBasePath();
  if (typeof uld.basePath === 'string') return uld.basePath;
  // Last resort — config path.
  return path.join(_internals.config.path, 'users');
}

async function collectUserIdsWithSeriesFile (baseDir: string): Promise<string[]> {
  // userLocalDirectory shards users as <base>/<c1>/<c2>/<c3>/<userId>/.
  // Scan three levels then collect user dirs that contain a series file.
  const userIds: string[] = [];
  const exists = async (p: string) => fs.access(p).then(() => true, () => false);
  const level0 = await fs.readdir(baseDir).catch(() => []);
  for (const a of level0) {
    const aPath = path.join(baseDir, a);
    const level1 = await fs.readdir(aPath).catch(() => []);
    for (const b of level1) {
      const bPath = path.join(aPath, b);
      const level2 = await fs.readdir(bPath).catch(() => []);
      for (const c of level2) {
        const cPath = path.join(bPath, c);
        const users = await fs.readdir(cPath).catch(() => []);
        for (const u of users) {
          const seriesPath = path.join(cPath, u, `${FILE_PREFIX}-${VERSION}.sqlite`);
          if (await exists(seriesPath)) userIds.push(u);
        }
      }
    }
  }
  return userIds;
}

export { SeriesConnectionSQLite };
