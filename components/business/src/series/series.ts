/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DataMatrix = require('./data_matrix.ts').default;

/**
 * Convert a timestamp (seconds) or ISO string to a quoted date string
 * for InfluxQL / series WHERE clauses.
 * @param v - timestamp in seconds or ISO date string
 */
type Timestamp = number;
type Query = {
  from?: Timestamp;
  to?: Timestamp;
};
type SeriesConnection = {
  writeMeasurement: (measurement: string, points: unknown[], options: { database: string }) => Promise<unknown>;
  query: (statement: string, options: { database: string }) => Promise<unknown[]>;
};
type Row = {
  toStruct (): Record<string, unknown> & { deltaTime?: number };
  get (field: string): unknown;
};
type SeriesData = {
  eachRow (cb: (row: Row) => void): void;
};

function timestampToDateString (v: number | string): string {
  const date = new Date(typeof v === 'number' ? v * 1000 : v);
  return "'" + date.toISOString().replace('T', ' ').replace('Z', '000000') + "'";
}

/** Represents a single data series.
 *
 * This is the high level internal interface to series. Series can be
 * manipulated through this interface.
 */
class Series {
  namespace: string;

  name: string;

  connection: SeriesConnection;
  /** Internal constructor, creates a series with a given name in the namespace
   * given.
   */
  constructor (conn: SeriesConnection, namespace: string, name: string) {
    this.connection = conn;
    this.namespace = namespace;
    this.name = name;
  }

  /** Append data to this series.
   *
   * This will append the data given in `data` to this series. You should
   * make sure that the data matches the event this series is linked to before
   * calling this method.
   *
   * @param data  - data to store to the series
   * @return - promise that resolves once the data is stored
   */
  append (data: SeriesData) {
    const appendOptions = {
      database: this.namespace
    };
    const points: Array<{ tags: unknown[]; fields: Record<string, unknown>; timestamp: unknown }> = [];
    // Transform all data rows into a measurement point. Transform of rows
    // is done via toStruct in DataMatrix.Row.
    const toMeasurement = (row: Row) => {
      const struct = row.toStruct();

      delete struct.deltaTime;
      const deltaTime = row.get('deltaTime');
      return {
        tags: [],
        fields: struct,
        timestamp: deltaTime
      };
    };
    data.eachRow((row: Row) => {
      points.push(toMeasurement(row));
    });
    return this.connection.writeMeasurement(this.name, points, appendOptions);
  }

  /** Queries the given series, returning a data matrix.
   */
  query (query: Query) {
    const queryOptions = { database: this.namespace };
    const measurementName = this.name;
    const condition = this.buildExpression(query);
    const wherePart = condition.length > 0 ? 'WHERE ' + condition.join(' AND ') : '';
    const statement = `
      SELECT * FROM "${measurementName}"
      ${wherePart}
      ORDER BY time ASC
    `;
    return this.connection
      .query(statement, queryOptions)
      .then((rows) => this.transformResult(rows as Array<Record<string, unknown>>));
  }

  /** Transforms an IResult object into a data matrix.
   */
  transformResult (result: Array<Record<string, unknown>>) {
    if (result.length <= 0) { return DataMatrix.empty(); }
    // assert: result.length > 0
    const headers = Object.keys(result[0]);
    const data = result.map((e: Record<string, unknown>) => headers.map((h) => e[h]));
    // Replace influx 'time' with 'deltaTime'
    const idx = headers.indexOf('time');
    if (idx >= 0) { headers[idx] = 'deltaTime'; }
    for (const row of data) {
      row[idx] = +(row[idx] as number) / 1000;
    }
    return new DataMatrix(headers, data);
  }

  /** Builds an expression that can be used within `WHERE` from a query.
   */
  buildExpression (query: Query): string[] {
    const subConditions: string[] = [];
    if (query.from) {
      subConditions.push(`time >= ${timestampToDateString(query.from)}`);
    }
    if (query.to) {
      subConditions.push(`time < ${timestampToDateString(query.to)}`);
    }
    return subConditions;
  }
}
export default Series;
export { Series };
