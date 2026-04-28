/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const bluebird = require('bluebird');
const { LRUCache: LRU } = require('lru-cache');
const errors = require('errors').factory;
const business = require('business');
const BatchRequest = business.series.BatchRequest;
const ApiConstants = require('../api_constants');
const TracedOperations = require('./traced_operations');
const setCommonMeta = require('api-server/src/methods/helpers/setCommonMeta').setCommonMeta;
// POST /:user_name/series/batch
//
/**
 * @param {Context} ctx
 * @param {express$Request} req
 * @param {express$Response} res
 * @returns {Promise<void>}
 */
async function storeSeriesBatch (ctx, req, res) {
  const trace = new TracedOperations(ctx);
  const seriesRepository = ctx.series;
  const userName = req.params.user_name;
  const accessToken = req.headers[ApiConstants.AUTH_HEADER];
  const body = req.body;
  // If params are not there, abort.
  if (accessToken == null) { throw errors.missingHeader(ApiConstants.AUTH_HEADER); }
  // Parse the data and resolve access rights and types.
  trace.start('parseData');
  const resolver = new EventMetaDataCache(userName, accessToken, ctx);
  const data = await parseData(body, resolver);
  trace.finish('parseData');
  // Iterate over all separate namespaces and store the data:
  trace.start('append');
  const dataByNamespace = await groupByNamespace(data, resolver);
  const results = [];
  for (const [ns, data] of dataByNamespace.entries()) {
    const batchStoreOperation = await seriesRepository.makeBatch(ns);
    results.push(batchStoreOperation.store(data, (eventId) => resolver.getMeasurementName(eventId)));
  }
  // Wait for all store operations to complete.
  await bluebird.all(results);
  trace.finish('append');
  trace.start('metadataUpdate');
  const entries = [];
  const now = new Date() / 1e3;
  for (const bre of data.elements()) {
    entries.push({
      userId: userName,
      eventId: bre.eventId,
      author: accessToken,
      timestamp: now,
      dataExtent: bre.data.minmax()
    });
  }
  await ctx.metadataUpdater.scheduleUpdate({
    entries
  });
  trace.finish('metadataUpdate');
  res.status(200).json(setCommonMeta({ status: 'ok' }));
}
// Parses the request body and transforms the data contained in it into the
// BatchRequest format.
//
/**
 * @param {unknown} batchRequestBody
 * @param {EventMetaDataCache} resolver
 * @returns {Promise<any>}
 */
function parseData (batchRequestBody, resolver) {
  return BatchRequest.parse(batchRequestBody, (eventId) => resolver.getRowType(eventId));
}
// This is how many eventId -> seriesMeta mappings we keep around in the
// EventMetaDataCache. Usually, batches will be about a small number of sensors,
// so setting this to around 100 will guarantee that events are loaded but once.
//
// NOTE that the metadata loader also caches and thus even missing this cache
//  will not be a catastrophe.
const METADATA_CACHE_SIZE = 100;
// Resolves eventIds to types for matrix verification.
//
// Contains a cache that will avoid loading the same event meta data twice
// during a single request;  but note that there is another cache one layer
// below. This is not strictly  neccessary, but a good practice given the
// requirements here (SOP).
//

class EventMetaDataCache {
  userName;

  accessToken;

  ctx;

  cache;
  constructor (userName, accessToken, ctx) {
    this.userName = userName;
    this.accessToken = accessToken;
    this.ctx = ctx;
    this.cache = new LRU({ max: METADATA_CACHE_SIZE });
  }

  // Loads an event, checks access rights for the current token, then looks
  // up the type of the event and returns it as a SeriesRowType.
  //
  /**
   * @param {string} eventId
   * @returns {Promise<any>}
   */
  async getRowType (eventId) {
    const ctx = this.ctx;
    const repo = ctx.typeRepository;
    const seriesMeta = await this.getSeriesMeta(eventId);
    if (seriesMeta.isTrashedOrDeleted()) {
      throw errors.invalidOperation(`The referenced event "${eventId}" is trashed.`, { trashedReference: 'eventId' });
    }
    if (!seriesMeta.canWrite()) { throw errors.forbidden(); }
    return seriesMeta.produceRowType(repo);
  }

  /**
   * @param {string} eventId
   * @returns {Promise<string>}
   */
  async getMeasurementName (eventId) {
    const seriesMeta = await this.getSeriesMeta(eventId);
    const [namespace, name] = seriesMeta.namespaceAndName(); // eslint-disable-line no-unused-vars
    return name;
  }

  // Returns the SeriesMetadata for the event designated by `eventId`.
  //
  /**
   * @returns {Promise<any>}
   */
  async getSeriesMeta (eventId) {
    const ctx = this.ctx;
    const loader = ctx.metadata;
    return this.fromCacheOrProduce(eventId, () => loader.forSeries(this.userName, eventId, this.accessToken));
  }

  // Handles memoisation through the cache in `this.cache`.
  //
  /**
   * @param {string} key
   * @param {() => Promise<SeriesMetadata>} factory
   * @returns {Promise<any>}
   */
  async fromCacheOrProduce (key, factory) {
    const cache = this.cache;
    // From Cache
    if (cache.has(key)) {
      const cachedValue = cache.get(key);
      if (cachedValue == null) { throw new Error('AF: Value cannot be null here.'); }
      return cachedValue;
    }
    const ctx = this.ctx;
    const span = ctx.childSpan('orProduce');
    // Or Produce
    const value = await factory();
    cache.set(key, value);
    span.finish();
    return value;
  }
}
// Introduces another level into the data structure `batchRequest` - grouping
// requests by series namespace. This will allow then creating one batch
// request by influx namespace and doing all of these requests in parallel.
//
// NOTE Since namespaces are currently determined only by the username and
//  since this request hardly gets handed two usernames at once, this will
//  currently always return a map with one entry. This doesn't make the
//  code harder to write; but it is more correct, since SOP.
//
/**
 * @returns {Promise<NamespacedBatchRequests>}
 */
async function groupByNamespace (batchRequest, resolver) {
  const nsToBatch = new Map();
  for (const element of batchRequest.elements()) {
    const eventId = element.eventId;
    const seriesMeta = await resolver.getSeriesMeta(eventId);
    const [namespace, name] = seriesMeta.namespaceAndName(); // eslint-disable-line no-unused-vars
    storeToMap(namespace, element);
  }
  return nsToBatch;
  function storeToMap (namespace, batchRequestElement) {
    if (!nsToBatch.has(namespace)) {
      nsToBatch.set(namespace, new BatchRequest());
    }
    const batch = nsToBatch.get(namespace);
    if (batch == null) { throw new Error('AF: batch cannot be null'); }
    batch.append(batchRequestElement);
  }
}
module.exports = storeSeriesBatch;

/** @typedef {Map<string, BatchRequest>} NamespacedBatchRequests */
