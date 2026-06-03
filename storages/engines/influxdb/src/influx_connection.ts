/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const influx = require('influx');
const { _internals } = require('./_internals.ts');

interface InfluxPoint {
  measurement?: string;
  tags?: Record<string, string>;
  fields?: Record<string, unknown>;
  timestamp?: unknown;
  [k: string]: unknown;
}

interface InfluxWriteOptions {
  database?: string;
  precision?: string;
  [k: string]: unknown;
}

interface InfluxQueryOptions {
  database?: string;
  [k: string]: unknown;
}

type InfluxQueryRow = Record<string, unknown>;
type InfluxQueryResult = InfluxQueryRow[];

interface InfluxDbClient {
  createDatabase: (name: string) => Promise<unknown>;
  dropDatabase: (name: string) => Promise<void>;
  writeMeasurement: (name: string, points: InfluxPoint[], options?: InfluxWriteOptions) => Promise<void>;
  dropMeasurement: (name: string, dbName: string) => Promise<void>;
  writePoints: (points: InfluxPoint[], options?: InfluxWriteOptions) => Promise<void>;
  query: (query: string, options?: InfluxQueryOptions) => Promise<InfluxQueryResult>;
  getDatabaseNames: () => Promise<string[]>;
}

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Connection to the influx database. Adds error handling and logging on top
 * of our database driver.
 */
class InfluxConnection {
  conn: InfluxDbClient;
  logger: Logger;

  constructor (connectionSettings: Record<string, unknown>) {
    this.conn = new influx.InfluxDB(connectionSettings);
    this.logger = _internals.lazyLogger('influx');
  }

  createDatabase (name: string): Promise<unknown> {
    this.logger.debug(`Creating database ${name}.`);
    return this.conn.createDatabase(name);
  }

  dropDatabase (name: string): Promise<void> {
    this.logger.debug(`Dropping database ${name}.`);
    return this.conn.dropDatabase(name);
  }

  writeMeasurement (name: string, points: InfluxPoint[], options?: InfluxWriteOptions): Promise<void> {
    this.logger.debug(`Write -> ${name}: ${points.length} points.`);
    return this.conn.writeMeasurement(name, points, options);
  }

  dropMeasurement (name: string, dbName: string): Promise<void> {
    this.logger.debug(`Drop -> measurement: ${name} on dbName ${dbName}`, this.logger);
    return this.conn.dropMeasurement(name, dbName);
  }

  writePoints (points: InfluxPoint[], options?: InfluxWriteOptions): Promise<void> {
    this.logger.debug(`Write -> (multiple): ${points.length} points.`);
    return this.conn.writePoints(points, options);
  }

  query (query: string, options?: InfluxQueryOptions): Promise<InfluxQueryResult> {
    const singleLine = query.replace(/\s+/g, ' ');
    this.logger.debug(`Query: ${singleLine}`);
    return this.conn.query(query, options);
  }

  /**
   * Used for tests, returns an array of database names.
   */
  getDatabases (): Promise<string[]> {
    return this.conn.getDatabaseNames();
  }

  /**
   * Export all measurements and their points from the given database.
   */
  async exportDatabase (name: string): Promise<{ measurements: Array<{ measurement: string, points: InfluxQueryRow[] }> }> {
    const measurementRows = await this.conn.query('SHOW MEASUREMENTS', { database: name });
    const measurements: Array<{ measurement: string, points: InfluxQueryRow[] }> = [];
    for (const row of measurementRows) {
      const measurementName = row.name as string;
      const points = await this.conn.query(`SELECT * FROM "${measurementName}"`, { database: name });
      measurements.push({ measurement: measurementName, points });
    }
    return { measurements };
  }

  /**
   * Import measurements and their points into the given database.
   * Creates the database if it does not exist.
   */
  async importDatabase (name: string, data: { measurements: Array<{ measurement: string, points: InfluxQueryRow[] }> }): Promise<void> {
    await this.createDatabase(name);
    for (const { measurement, points } of data.measurements) {
      if (points.length === 0) continue;
      const writePoints = points.map((p: InfluxQueryRow) => {
        const fields: Record<string, unknown> = {};
        const tags: Record<string, string> = {};
        for (const [key, value] of Object.entries(p)) {
          if (key === 'time') continue;
          if (typeof value === 'string') {
            tags[key] = value;
          } else {
            fields[key] = value;
          }
        }
        return {
          measurement,
          tags,
          fields,
          timestamp: p.time
        };
      });
      await this.conn.writePoints(writePoints, { database: name });
    }
  }
}

export { InfluxConnection };
