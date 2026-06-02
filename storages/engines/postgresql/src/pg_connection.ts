/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

type PgDb = {
  query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type Logger = { debug (msg: string): void };
type FieldsObj = Record<string, unknown>;
type SeriesPoint = Record<string, unknown> & { time?: number };

/**
 * PostgreSQL implementation of the InfluxConnection interface.
 */
class PGSeriesConnection {
  db: PgDb;
  logger: Logger;

  constructor (db: PgDb) {
    this.db = db;
    this.logger = _internals.getLogger('pg-series');
  }

  async createDatabase (name: string): Promise<void> {
    this.logger.debug(`createDatabase: ${name} (no-op in PG)`);
  }

  async dropDatabase (name: string): Promise<void> {
    this.logger.debug(`dropDatabase: ${name}`);
    await this.db.query(
      'DELETE FROM series_data WHERE user_id = $1',
      [name]
    );
  }

  async writeMeasurement (name: string, points: Array<{ fields: FieldsObj, timestamp: number }>, options: { database: string }): Promise<void> {
    const userId = options.database;
    this.logger.debug(`writeMeasurement: ${name} (${points.length} points)`);

    if (points.length === 0) return;

    await batchUpsert(this.db, points.map(point => {
      const deltaTime = point.timestamp;
      const pointTime = typeof deltaTime === 'number' ? deltaTime : Number(deltaTime);
      return [userId, name, pointTime, deltaTime, JSON.stringify(point.fields)];
    }));
  }

  async writePoints (points: Array<{ measurement: string, fields: FieldsObj, timestamp: number }>, options: { database: string }): Promise<void> {
    const userId = options.database;
    this.logger.debug(`writePoints: ${points.length} points`);

    if (points.length === 0) return;

    await batchUpsert(this.db, points.map(point => {
      const deltaTime = point.timestamp;
      const pointTime = typeof deltaTime === 'number' ? deltaTime : Number(deltaTime);
      return [userId, point.measurement, pointTime, deltaTime, JSON.stringify(point.fields)];
    }));
  }

  async dropMeasurement (name: string, dbName: string): Promise<void> {
    this.logger.debug(`dropMeasurement: ${name} on ${dbName}`);
    await this.db.query(
      'DELETE FROM series_data WHERE user_id = $1 AND event_id = $2',
      [dbName, name]
    );
  }

  async query (queryStr: string, options: { database: string }): Promise<Array<Record<string, unknown>>> {
    const userId = options.database;
    const singleLine = queryStr.replace(/\s+/g, ' ').trim();
    this.logger.debug(`query: ${singleLine}`);

    // Handle SHOW MEASUREMENTS
    if (/^SHOW\s+MEASUREMENTS$/i.test(singleLine)) {
      const res = await this.db.query(
        'SELECT DISTINCT event_id AS name FROM series_data WHERE user_id = $1',
        [userId]
      );
      return res.rows;
    }

    // Parse SELECT query
    const parsed = parseInfluxSelect(singleLine);
    if (!parsed) {
      throw new Error(`PGSeriesConnection: unsupported query: ${singleLine}`);
    }

    const conditions: string[] = ['user_id = $1', 'event_id = $2'];
    const params: unknown[] = [userId, parsed.measurement];
    let idx = 3;

    for (const cond of parsed.conditions) {
      if (cond.op === '>=' || cond.op === '<' || cond.op === '>' || cond.op === '<=') {
        conditions.push(`delta_time ${cond.op} $${idx}`);
        params.push(cond.value);
        idx++;
      }
    }

    const sql = `SELECT delta_time, fields FROM series_data WHERE ${conditions.join(' AND ')} ORDER BY delta_time ASC`;
    const res = await this.db.query(sql, params);

    // Transform to InfluxDB-like result format
    return res.rows.map((row: Record<string, unknown>) => {
      const result: SeriesPoint = {};
      result.time = (row.delta_time as number) / 1e6;
      if (row.fields && typeof row.fields === 'object') {
        Object.assign(result, row.fields);
      }
      return result;
    });
  }

  /**
   * Get list of databases (user_ids that have series data).
   */
  async getDatabases (): Promise<string[]> {
    const res = await this.db.query(
      'SELECT DISTINCT user_id FROM series_data'
    );
    return res.rows.map((r: Record<string, unknown>) => r.user_id as string);
  }

  /**
   * Export all measurements and their points from a user's series data.
   */
  async exportDatabase (name: string): Promise<{ measurements: Array<{ measurement: string, points: SeriesPoint[] }> }> {
    const measurementRes = await this.db.query(
      'SELECT DISTINCT event_id FROM series_data WHERE user_id = $1',
      [name]
    );

    const measurements: Array<{ measurement: string, points: SeriesPoint[] }> = [];
    for (const row of measurementRes.rows) {
      const eventId = row.event_id as string;
      const pointsRes = await this.db.query(
        'SELECT delta_time, fields FROM series_data WHERE user_id = $1 AND event_id = $2 ORDER BY delta_time ASC',
        [name, eventId]
      );
      const points = pointsRes.rows.map((r: Record<string, unknown>) => {
        const point: SeriesPoint = {};
        point.time = (r.delta_time as number) / 1e6;
        if (r.fields && typeof r.fields === 'object') {
          Object.assign(point, r.fields);
        }
        return point;
      });
      measurements.push({ measurement: eventId, points });
    }

    return { measurements };
  }

  /**
   * Import measurements and their points into a user's series data.
   */
  async importDatabase (name: string, data: { measurements: Array<{ measurement: string, points: SeriesPoint[] }> }): Promise<void> {
    await this.createDatabase(name); // no-op

    for (const { measurement, points } of data.measurements) {
      if (!points || points.length === 0) continue;

      const rows = points.map((p: SeriesPoint) => {
        const fields: FieldsObj = {};
        const tags: FieldsObj = {};
        for (const [key, value] of Object.entries(p)) {
          if (key === 'time') continue;
          if (typeof value === 'string') {
            tags[key] = value;
          } else {
            fields[key] = value;
          }
        }
        const allFields = Object.assign({}, fields, tags);
        const deltaTime = typeof p.time === 'number' ? p.time * 1e6 : Number(p.time) * 1e6;
        return [name, measurement, deltaTime, deltaTime, JSON.stringify(allFields)];
      });

      await batchUpsert(this.db, rows);
    }
  }
}

/**
 * Parse a simple InfluxQL SELECT query.
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
      // `series.ts:timestampToDateString` emits InfluxQL-style time literals
      // like '1970-01-01 00:00:01.000000000' (no TZ marker — InfluxDB treats
      // these as UTC). `new Date()` without a TZ suffix parses as LOCAL time,
      // which yields a wrong nanos range on non-UTC machines and silently
      // returns 0 rows. Append 'Z' so JS parses as UTC, matching InfluxDB's
      // semantics.
      const dateMs = new Date(match[2] + 'Z').getTime();
      const nanoSecs = dateMs * 1e6;
      conditions.push({ op: match[1], value: nanoSecs });
    }
  }

  return { measurement, conditions };
}

const BATCH_SIZE = 5000;

async function batchUpsert (db: PgDb, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params: unknown[] = [];
    const valueClauses: string[] = [];
    for (let j = 0; j < chunk.length; j++) {
      const base = j * 5;
      valueClauses.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(...chunk[j]);
    }
    await db.query(
      `INSERT INTO series_data (user_id, event_id, point_time, delta_time, fields)
       VALUES ${valueClauses.join(', ')}
       ON CONFLICT (user_id, event_id, point_time)
       DO UPDATE SET delta_time = EXCLUDED.delta_time, fields = EXCLUDED.fields`,
      params
    );
  }
}

export { PGSeriesConnection };