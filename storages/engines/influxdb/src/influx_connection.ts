/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const influx = require('influx');
const _internals = require('./_internals');

/**
 * Connection to the influx database. Adds error handling and logging on top
 * of our database driver.
 */
class InfluxConnection {
  conn: any;
  logger: any;

  constructor (connectionSettings: Record<string, any>) {
    this.conn = new influx.InfluxDB(connectionSettings);
    this.logger = _internals.lazyLogger('influx');
  }

  createDatabase (name: string): Promise<any> {
    this.logger.debug(`Creating database ${name}.`);
    return this.conn.createDatabase(name);
  }

  dropDatabase (name: string): Promise<void> {
    this.logger.debug(`Dropping database ${name}.`);
    return this.conn.dropDatabase(name);
  }

  writeMeasurement (name: string, points: any[], options?: any): Promise<void> {
    this.logger.debug(`Write -> ${name}: ${points.length} points.`);
    return this.conn.writeMeasurement(name, points, options);
  }

  dropMeasurement (name: string, dbName: string): Promise<void> {
    this.logger.debug(`Drop -> measurement: ${name} on dbName ${dbName}`, this.logger);
    return this.conn.dropMeasurement(name, dbName);
  }

  writePoints (points: any[], options?: any): Promise<void> {
    this.logger.debug(`Write -> (multiple): ${points.length} points.`);
    return this.conn.writePoints(points, options);
  }

  query (query: string, options?: any): Promise<any> {
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
  async exportDatabase (name: string): Promise<{ measurements: Array<{ measurement: string, points: any[] }> }> {
    const measurementRows = await this.conn.query('SHOW MEASUREMENTS', { database: name });
    const measurements: Array<{ measurement: string, points: any[] }> = [];
    for (const row of measurementRows) {
      const measurementName = row.name;
      const points = await this.conn.query(`SELECT * FROM "${measurementName}"`, { database: name });
      measurements.push({ measurement: measurementName, points });
    }
    return { measurements };
  }

  /**
   * Import measurements and their points into the given database.
   * Creates the database if it does not exist.
   */
  async importDatabase (name: string, data: { measurements: Array<{ measurement: string, points: any[] }> }): Promise<void> {
    await this.createDatabase(name);
    for (const { measurement, points } of data.measurements) {
      if (points.length === 0) continue;
      const writePoints = points.map((p: Record<string, any>) => {
        const fields: Record<string, any> = {};
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

module.exports = InfluxConnection;
