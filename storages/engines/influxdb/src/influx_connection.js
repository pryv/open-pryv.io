/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const influx = require('influx');
const _internals = require('./_internals');
/** Connection to the influx database. Adds error handling and logging on top
 * of our database driver.
 */
class InfluxConnection {
  conn;

  logger;
  constructor (connectionSettings) {
    this.conn = new influx.InfluxDB(connectionSettings);
    this.logger = _internals.lazyLogger('influx');
  }

  /**
   * @param {string} name
   * @returns {Promise<any>}
   */
  createDatabase (name) {
    this.logger.debug(`Creating database ${name}.`);
    return this.conn.createDatabase(name);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  dropDatabase (name) {
    this.logger.debug(`Dropping database ${name}.`);
    return this.conn.dropDatabase(name);
  }

  /**
   * @param {string} name
   * @param {Array<IPoint>} points
   * @param {IWriteOptions} options
   * @returns {Promise<void>}
   */
  writeMeasurement (name, points, options) {
    this.logger.debug(`Write -> ${name}: ${points.length} points.`);
    return this.conn.writeMeasurement(name, points, options);
  }

  /**
   * @param {string} name
   * @param {string} dbName
   * @returns {Promise<void>}
   */
  dropMeasurement (name, dbName) {
    this.logger.debug(`Drop -> measurement: ${name} on dbName ${dbName}`, this.logger);
    return this.conn.dropMeasurement(name, dbName);
  }

  /**
   * @param {Array<IPoint>} points
   * @param {IWriteOptions} options
   * @returns {Promise<void>}
   */
  writePoints (points, options) {
    this.logger.debug(`Write -> (multiple): ${points.length} points.`);
    return this.conn.writePoints(points, options);
  }

  /**
   * @param {string} query
   * @param {IQueryOptions} options
   * @returns {Promise<any>}
   */
  query (query, options) {
    const singleLine = query.replace(/\s+/g, ' ');
    this.logger.debug(`Query: ${singleLine}`);
    return this.conn.query(query, options);
  }

  /**
   * used for tests, Returns an array of database names
   * @returns {Promise<string[]>}
   */
  getDatabases () {
    return this.conn.getDatabaseNames();
  }

  /**
   * Export all measurements and their points from the given database.
   * @param {string} name - Database name
   * @returns {Promise<{measurements: Array<{measurement: string, points: Object[]}>}>}
   */
  async exportDatabase (name) {
    const measurementRows = await this.conn.query('SHOW MEASUREMENTS', { database: name });
    const measurements = [];
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
   * @param {string} name - Database name
   * @param {{measurements: Array<{measurement: string, points: Object[]}>}} data
   * @returns {Promise<void>}
   */
  async importDatabase (name, data) {
    await this.createDatabase(name);
    for (const { measurement, points } of data.measurements) {
      if (points.length === 0) continue;
      const writePoints = points.map((p) => {
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
