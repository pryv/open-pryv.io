/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
//
const Series = require('./series.ts').default;
const NamespaceBatch = require('./namespace_batch.ts').default;
/** Repository of all series in this Pryv instance.
 */
type ConnectionLike = { createDatabase: (name: string) => Promise<void> | void; [k: string]: unknown };

class Repository {
  connection: ConnectionLike;
  /** Constructs a series repository based on a connection to InfluxDB.
   *
   * @param influxConnection {InfluxDB} handle to the database instance
   */
  constructor (influxConnection: ConnectionLike) {
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
   */
  async get (namespace: string, name: string) {
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
  async makeBatch (namespace: string) {
    // Make sure that the database exists:
    await this.connection.createDatabase(namespace);
    return new NamespaceBatch(this.connection, namespace);
  }
}
export default Repository;
export { Repository };