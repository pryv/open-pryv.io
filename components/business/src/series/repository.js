/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
//
const Series = require('./series');
const NamespaceBatch = require('./namespace_batch');
/** Repository of all series in this Pryv instance.
 */
class Repository {
  connection;
  /** Constructs a series repository based on a connection to InfluxDB.
   *
   * @param influxConnection {InfluxDB} handle to the database instance
   */
  constructor (influxConnection) {
    this.connection = influxConnection;
  }

  /** Return a series from a given namespace.
   *
   * In practice, we'll map namespaces to pryv users and series to events. Please
   * see MetadataRepository and SeriesMetadata for how to get a namespace and a
   * name.
   *
   * Example:
   *
   *    seriesRepo.get(...seriesMeta.namespace())
   * @param {string} namespace
   * @param {string} name
   * @returns {Promise<any>}
   */
  async get (namespace, name) {
    // TODO Cache all the setup checks we do here in an LRU cache.
    // Make sure that the database exists:
    await this.connection.createDatabase(namespace);
    return new Series(this.connection, namespace, name);
  }

  // Return a namespace batch that allows storing to multiple series at once.
  //
  // Example:
  //
  //    const batch = await seriesRepo.makeBatch('foo');
  //    batch.append(batchRequest);
  //    // ... as many times as you like
  //    await batch.store();
  //
  /**
   * @param {string} namespace
   * @returns {Promise<any>}
   */
  async makeBatch (namespace) {
    // TODO Cache all the setup checks we do here in an LRU cache.
    // Make sure that the database exists:
    await this.connection.createDatabase(namespace);
    return new NamespaceBatch(this.connection, namespace);
  }
}
module.exports = Repository;
