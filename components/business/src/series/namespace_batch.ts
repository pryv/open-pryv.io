/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

// A store operation that stores data for multiple series in one call to the
// backend.
//
// Example:
//
//    const batch = await repository.makeBatch(...);
//    await batch.store();
//

type IPoint = {
  tags: string[];
  fields: Record<string, unknown>;
  timestamp: number;
  measurement: string;
};

type Row = {
  toStruct: () => Record<string, unknown>;
  get: (field: string) => number;
};

type BatchElement = {
  eventId: string;
  data: { eachRow: (cb: (row: Row) => void) => void };
};

type BatchRequest = { elements: () => Iterable<BatchElement> };

type Connection = {
  writePoints: (points: IPoint[], opts: { database: string }) => Promise<unknown>;
};

type MeasurementNameResolver = (eventId: string) => Promise<string>;

class NamespaceBatch {
  connection: Connection;

  namespace: string;
  constructor (conn: Connection, namespace: string) {
    this.connection = conn;
    this.namespace = namespace;
  }

  // Stores a batch request into InfluxDB and returns a promise that will
  // resolve once the request completes successfully.
  async store (data: BatchRequest, resolver: MeasurementNameResolver): Promise<unknown> {
    // These options will apply to all the points:
    const appendOptions = {
      database: this.namespace
    };
    const points: IPoint[] = [];
    // Loop through all batch requests and convert each row into an IPoint
    // structure.
    for (const element of data.elements()) {
      const eventId = element.eventId;
      const data = element.data;
      const measurementName = await resolver(eventId);
      data.eachRow((row: Row) => {
        points.push(toIPoint(eventId, row, measurementName));
      });
    }
    const conn = this.connection;
    return conn.writePoints(points, appendOptions);

    // Converts a single `Row` of data into an IPoint structure.
    function toIPoint (eventId: string, row: Row, measurementName: string): IPoint {
      const struct = row.toStruct();
      delete struct.deltaTime;

      const timestamp = row.get('deltaTime');
      return {
        tags: [],
        fields: struct,
        timestamp,
        measurement: measurementName
      };
    }
  }
}
export default NamespaceBatch;
export { NamespaceBatch };