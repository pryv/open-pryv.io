/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// A store operation that stores data for multiple series in one call to the
// backend.
//
// Example:
//
//    const batch = await repository.makeBatch(...);
//    await batch.store();
//

class NamespaceBatch {
  connection;

  namespace;
  constructor (conn, namespace) {
    this.connection = conn;
    this.namespace = namespace;
  }

  // Stores a batch request into InfluxDB and returns a promise that will
  // resolve once the request completes successfully.
  /**
   * @param {BatchRequest} data
   * @param {MeasurementNameResolver} resolver
   * @returns {Promise<any>}
   */
  async store (data, resolver) {
    // These options will apply to all the points:
    const appendOptions = {
      database: this.namespace
    };
    const points = [];
    // Loop through all batch requests and convert each row into an IPoint
    // structure.
    for (const element of data.elements()) {
      const eventId = element.eventId;
      const data = element.data;
      const measurementName = await resolver(eventId);
      data.eachRow((row) => {
        points.push(toIPoint(eventId, row, measurementName));
      });
    }
    const conn = this.connection;
    return conn.writePoints(points, appendOptions);

    // Converts a single `Row` of data into an IPoint structure.
    function toIPoint (eventId, row, measurementName) {
      const struct = row.toStruct();
      // TODO review this now that flow is gone:
      // This cannot fail, but somehow flow things we access the deltaTime.
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
module.exports = NamespaceBatch;

/** @typedef {(eventId: string) => Promise<string>} MeasurementNameResolver */
