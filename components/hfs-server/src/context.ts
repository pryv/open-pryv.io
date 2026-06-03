/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const business = require('business');
const { MetadataLoader, MetadataCache } = require('./metadata_cache.ts');
const { MetadataUpdater, MetadataForgetter } = require('./metadata_updater.ts');
const cls = require('./tracing/cls.ts').default;
const { getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
// Application context object, holding references to all major subsystems. Once
// the system is initialized, these instance references will not change  any
// more and together make up the configuration of the system.
//

type SeriesRepository = unknown;
type MetadataCacheLike = unknown;
type MetadataUpdaterLike = { start?: () => void; [k: string]: unknown };
type TypeRepoLike = { tryUpdate: (url: string) => void; [k: string]: unknown };
type TracerSpan = { end?: () => void; [k: string]: unknown };
type TracerLike = { startSpan: (name: string, opts?: Record<string, unknown>) => TracerSpan };
type ConfigLike = { get: (key: string) => unknown; [k: string]: unknown };
type InfluxConnection = unknown;

class Context {
  series: SeriesRepository;

  metadata?: MetadataCacheLike;

  metadataUpdater: MetadataUpdaterLike;

  // Application level performance and error tracing:

  tracer: TracerLike;

  typeRepository!: TypeRepoLike;

  config: ConfigLike;
  constructor (influxConn: InfluxConnection, tracer: TracerLike, typeRepoUpdateUrl: string, config: ConfigLike) {
    this.series = new business.series.Repository(influxConn);
    this.metadataUpdater = new MetadataForgetter(getLogger('metadata.update'));
    this.tracer = tracer;
    this.config = config;
    this.configureTypeRepository(typeRepoUpdateUrl);
  }

  async init (): Promise<void> {
    await this.configureMetadataCache();
  }

  configureTypeRepository (url: string): void {
    const typeRepo: TypeRepoLike = new business.types.TypeRepository();
    typeRepo.tryUpdate(url); // async
    this.typeRepository = typeRepo;
  }

  async configureMetadataCache (): Promise<void> {
    const mall = await getMall();
    const metadataLoader = new MetadataLoader();
    await metadataLoader.init(mall, getLogger('metadata-cache'));
    this.metadata = new MetadataCache(this.series, metadataLoader, this.config);
  }

  // Starts the in-process metadata updater.
  //
  startMetadataUpdater (): void {
    const updater: MetadataUpdaterLike = new MetadataUpdater();
    updater.start!();
    this.metadataUpdater = updater;
  }

  // Starts a child span below the request span.
  //
  childSpan (name: string, opts?: Record<string, unknown>): TracerSpan {
    const tracer = this.tracer;
    const rootSpan = cls.getRootSpan();
    const spanOpts = Object.assign({}, { childOf: rootSpan }, opts);
    const span = tracer.startSpan(name, spanOpts);
    // It becomes our new root - setRootSpan hooks the span to detect an end.
    cls.setRootSpan(span);
    return span;
  }
}
export default Context;
export { Context };