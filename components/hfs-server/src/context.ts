/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const business = require('business');
const { MetadataLoader, MetadataCache } = require('./metadata_cache');
const { MetadataUpdater, MetadataForgetter } = require('./metadata_updater');
const cls = require('./tracing/cls');
const { getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
// Application context object, holding references to all major subsystems. Once
// the system is initialized, these instance references will not change  any
// more and together make up the configuration of the system.
//

class Context {
  series;

  metadata;

  metadataUpdater;

  // Application level performance and error tracing:

  tracer;

  typeRepository;

  config;
  constructor (influxConn, tracer, typeRepoUpdateUrl, config) {
    this.series = new business.series.Repository(influxConn);
    this.metadataUpdater = new MetadataForgetter(getLogger('metadata.update'));
    this.tracer = tracer;
    this.config = config;
    this.configureTypeRepository(typeRepoUpdateUrl);
  }

  /**
   * @returns {Promise<void>}
   */
  async init () {
    await this.configureMetadataCache();
  }

  /**
   * @param {string} url
   * @returns {void}
   */
  configureTypeRepository (url) {
    const typeRepo = new business.types.TypeRepository();
    typeRepo.tryUpdate(url); // async
    this.typeRepository = typeRepo;
  }

  /**
   * @returns {Promise<void>}
   */
  async configureMetadataCache () {
    const mall = await getMall();
    const metadataLoader = new MetadataLoader();
    await metadataLoader.init(mall, getLogger('metadata-cache'));
    this.metadata = new MetadataCache(this.series, metadataLoader, this.config);
  }

  // Starts the in-process metadata updater.
  //
  startMetadataUpdater () {
    const updater = new MetadataUpdater();
    updater.start();
    this.metadataUpdater = updater;
  }

  // Starts a child span below the request span.
  //
  /**
   * @param {string} name
   * @param {any} opts
   * @returns {any}
   */
  childSpan (name, opts) {
    const tracer = this.tracer;
    const rootSpan = cls.getRootSpan();
    const spanOpts = Object.assign({}, { childOf: rootSpan }, opts);
    const span = tracer.startSpan(name, spanOpts);
    // It becomes our new root - setRootSpan hooks the span to detect an end.
    cls.setRootSpan(span);
    return span;
  }
}
module.exports = Context;

/** @typedef {business.series.Repository} Repository */
