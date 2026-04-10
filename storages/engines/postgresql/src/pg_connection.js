/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const _internals = require('./_internals');

/**
 * PostgreSQL implementation of the InfluxConnection interface.
 * Replaces InfluxDB for time-series storage using the shared `series_data` table.
 *
 * Mapping:
 * - InfluxDB "database" (namespace) → PG user_id
 * - InfluxDB "measurement" name → PG event_id
 * - InfluxDB point timestamp → PG delta_time
 * - InfluxDB point fields → PG fields (JSONB)
 */
class PGSeriesConnection {
  /** @type {import('storage/src/DatabasePG')} */
  db;
  logger;

  constructor (db) {
    this.db = db;
    this.logger = _internals.getLogger('pg-series');
  }

  /**
   * Create database — no-op in PG (single database, user_id partitioning).
   * @param {string} name - Database/namespace name (maps to user_id)
   */
  async createDatabase (name) {
    this.logger.debug(`createDatabase: ${name} (no-op in PG)`);
    // No-op: PG uses a single database with user_id partitioning
  }

  /**
   * Drop database — deletes all series data for a user.
   * @param {string} name - Database/namespace name (maps to user_id)
   */
  async dropDatabase (name) {
    this.logger.debug(`dropDatabase: ${name}`);
    await this.db.query(
      'DELETE FROM series_data WHERE user_id = $1',
      [name]
    );
  }

  /**
   * Write measurement points for a single measurement (event).
   * @param {string} name - Measurement name (event_id)
   * @param {Array<{fields: Object, timestamp: number}>} points
   * @param {{database: string}} options - options.database = user_id
   */
  async writeMeasurement (name, points, options) {
    const userId = options.database;
    this.logger.debug(`writeMeasurement: ${name} (${points.length} points)`);

    if (points.length === 0) return;

    await batchUpsert(this.db, points.map(point => {
      const deltaTime = point.timestamp;
      const pointTime = typeof deltaTime === 'number' ? deltaTime : Number(deltaTime);
      return [userId, name, pointTime, deltaTime, JSON.stringify(point.fields)];
    }));
  }

  /**
   * Write points for multiple measurements in one call.
   * @param {Array<{measurement: string, fields: Object, timestamp: number}>} points
   * @param {{database: string}} options - options.database = user_id
   */
  async writePoints (points, options) {
    const userId = options.database;
    this.logger.debug(`writePoints: ${points.length} points`);

    if (points.length === 0) return;

    await batchUpsert(this.db, points.map(point => {
      const deltaTime = point.timestamp;
      const pointTime = typeof deltaTime === 'number' ? deltaTime : Number(deltaTime);
      return [userId, point.measurement, pointTime, deltaTime, JSON.stringify(point.fields)];
    }));
  }

  /**
   * Drop a measurement — delete all series data for a specific event.
   * @param {string} name - Measurement name (event_id)
   * @param {string} dbName - Database name (user_id)
   */
  async dropMeasurement (name, dbName) {
    this.logger.debug(`dropMeasurement: ${name} on ${dbName}`);
    await this.db.query(
      'DELETE FROM series_data WHERE user_id = $1 AND event_id = $2',
      [dbName, name]
    );
  }

  /**
   * Query series data.
   * Accepts a simplified InfluxQL-like query and converts to SQL.
   *
   * Supported query patterns:
   * - SELECT * FROM "name" ORDER BY time ASC
   * - SELECT * FROM "name" WHERE time >= '...' AND time < '...' ORDER BY time ASC
   * - SHOW MEASUREMENTS (returns list of distinct event_ids)
   *
   * @param {string} queryStr - InfluxQL-like query string
   * @param {{database: string}} options - options.database = user_id
   * @returns {Promise<Array<Object>>} - Array of row objects with field values + time
   */
  async query (queryStr, options) {
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

    const conditions = ['user_id = $1', 'event_id = $2'];
    const params = [userId, parsed.measurement];
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

    // Transform to InfluxDB-like result format:
    // Array of objects with field names as keys + 'time' key.
    // delta_time is stored in nanoseconds (InfluxDateType.coerce converts
    // seconds → nanoseconds before writing). Convert to milliseconds to match
    // InfluxDB's INanoDate Number() conversion used by Series.transformResult.
    // Time is placed first to match InfluxDB's field ordering.
    return res.rows.map((row) => {
      const result = {};
      result.time = row.delta_time / 1e6;
      if (row.fields && typeof row.fields === 'object') {
        Object.assign(result, row.fields);
      }
      return result;
    });
  }

  /**
   * Get list of databases (user_ids that have series data).
   * @returns {Promise<string[]>}
   */
  async getDatabases () {
    const res = await this.db.query(
      'SELECT DISTINCT user_id FROM series_data'
    );
    return res.rows.map((r) => r.user_id);
  }

  /**
   * Export all measurements and their points from a user's series data.
   * @param {string} name - Database/namespace name (user_id)
   * @returns {Promise<{measurements: Array<{measurement: string, points: Object[]}>}>}
   */
  async exportDatabase (name) {
    // Get distinct measurements (event_ids)
    const measurementRes = await this.db.query(
      'SELECT DISTINCT event_id FROM series_data WHERE user_id = $1',
      [name]
    );

    const measurements = [];
    for (const row of measurementRes.rows) {
      const eventId = row.event_id;
      const pointsRes = await this.db.query(
        'SELECT delta_time, fields FROM series_data WHERE user_id = $1 AND event_id = $2 ORDER BY delta_time ASC',
        [name, eventId]
      );
      const points = pointsRes.rows.map((r) => {
        const point = {};
        // delta_time is in nanoseconds; convert to milliseconds for consistency
        point.time = r.delta_time / 1e6;
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
   * @param {string} name - Database/namespace name (user_id)
   * @param {{measurements: Array<{measurement: string, points: Object[]}>}} data
   */
  async importDatabase (name, data) {
    await this.createDatabase(name); // no-op

    for (const { measurement, points } of data.measurements) {
      if (!points || points.length === 0) continue;

      const rows = points.map(p => {
        const fields = {};
        const tags = {};
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
 * @param {string} query
 * @returns {{ measurement: string, conditions: Array<{op: string, value: number}> } | null}
 */
function parseInfluxSelect (query) {
  // Match: SELECT ... FROM "measurement" [WHERE ...] [ORDER BY ...]
  const fromMatch = query.match(/FROM\s+"?([^"\s]+)"?/i);
  if (!fromMatch) return null;

  const measurement = fromMatch[1];
  const conditions = [];

  // Extract WHERE conditions (time comparisons)
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+ORDER|\s*$)/i);
  if (whereMatch) {
    const whereStr = whereMatch[1];
    // Match time conditions: time >= '...' or time < '...'
    const timeRegex = /time\s*(>=|<=|>|<)\s*'([^']+)'/g;
    let match;
    while ((match = timeRegex.exec(whereStr)) !== null) {
      // Convert ISO date string to nanosecond timestamp
      const dateMs = new Date(match[2]).getTime();
      // Store as the same unit as delta_time (seconds * 1e6 for microseconds)
      // InfluxDB uses nanoseconds, but the influx library converts for us
      const nanoSecs = dateMs * 1e6;
      conditions.push({ op: match[1], value: nanoSecs });
    }
  }

  return { measurement, conditions };
}

/**
 * Batch upsert rows into series_data using multi-row VALUES.
 * Each row is [user_id, event_id, point_time, delta_time, fields_json].
 * Chunks into batches of BATCH_SIZE to stay within PG parameter limits.
 */
const BATCH_SIZE = 5000; // 5000 rows × 5 params = 25000 (PG limit ~65535)

async function batchUpsert (db, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const valueClauses = [];
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

module.exports = PGSeriesConnection;
