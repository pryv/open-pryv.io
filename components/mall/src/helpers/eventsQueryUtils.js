/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const storeDataUtils = require('./storeDataUtils');

module.exports = {
  getParamsByStore,
  getStoreOptionsFromParams,
  getStoreQueryFromParams,
  normalizeStreamQuery
};

/**
 * A generic query for events.get, events.updateMany, events.delete
 * @typedef {Object} EventsGetQuery
 * @property {string} [id] - an event id
 * @property {Array<StreamQuery>} [streams] - an array of stream queries (see StreamQuery)
 * @property {('trashed'|'all'|null)} [state=null] - get only trashed, all document or non-trashed events (default is non-trashed)
 * @property {Array<EventType>} [types] - reduce scope of events to a set of types
 * @property {timestamp} [fromTime] - events with a time of endTime after this timestamp
 * @property {timestamp} [toTime] - events with a time of endTime before this timestamp
 * @property {timestamp} [modifiedSince] - events modified after this timestamp
 * @property {boolean} [running] - events with an EndTime "null"
 */

/**
 * Get per-store query params from the given API query params.
 * @param {EventsGetQuery} params - a query object
 * @returns {Object.<String, EventsGetQuery>}
 * @throws {Error} if params.headId is set
 * @throws {Error} if query.id is set and params.streams is querying a different store
 * @throws {Error} if query.streams contains stream queries that implies different stores
 */
function getParamsByStore (params) {
  let singleStoreId, singleStoreEventId;
  if (params.id) { // a specific event is queried so we have a singleStore query;
    [singleStoreId, singleStoreEventId] = storeDataUtils.parseStoreIdAndStoreItemId(params.id);
  }

  if (params.headId) { // a specific "head" is queried so we have a singleStore query;
    throw new Error('Cannot use headId and id in query');
  }

  // repack stream queries by store
  const streamQueriesByStore = {};
  if (params.streams) { // must be an array
    for (const streamQuery of params.streams) {
      const context = { storeId: null };

      const resCleanQuery = getStoreStreamQuery(streamQuery, context);
      const storeId = context.storeId;

      if (singleStoreId && singleStoreId !== storeId) throw new Error('streams query must be from the same store than the requested event');
      streamQueriesByStore[storeId] ??= [];
      streamQueriesByStore[storeId].push(resCleanQuery);
    }
  }

  const paramsByStore = {};
  for (const storeId of Object.keys(streamQueriesByStore)) {
    paramsByStore[storeId] = structuredClone(params);
    paramsByStore[storeId].streams = streamQueriesByStore[storeId];
  }

  if (singleStoreId) {
    paramsByStore[singleStoreId] ??= structuredClone(params);
    paramsByStore[singleStoreId].id = singleStoreEventId;
  }

  if (Object.keys(paramsByStore).length === 0) { // default is local + account
    paramsByStore.local = structuredClone(params);
    delete paramsByStore.local.streams;
    // Also query account store — account events live in a separate store
    paramsByStore[storeDataUtils.AccountStoreId] = structuredClone(params);
    delete paramsByStore[storeDataUtils.AccountStoreId].streams;
  }

  return paramsByStore;
}

function getStoreStreamQuery (streamQuery, context) {
  const storeStreamQuery = {};
  for (const operator of ['any', 'not']) { // for each possible segment of query
    if (streamQuery[operator]) {
      for (const streamId of streamQuery[operator]) {
        const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
        context.storeId ??= storeId;
        if (context.storeId !== storeId) throw new Error('Streams within a query must belong to the same store');
        storeStreamQuery[operator] ??= [];
        storeStreamQuery[operator].push(storeStreamId);
      }
    }
  }
  if (streamQuery.and) {
    storeStreamQuery.and = streamQuery.and.map(sq => { return getStoreStreamQuery(sq, context); });
  }
  return storeStreamQuery;
}

/**
 *  /!\ As per 1.9.0 we decided to keep a streamQuery in the format of [{any: ..}, {not: ...}, {any: ...}] an extra step
 *      `normalizeStreamQuery` is added, the full process should be refactored in order to avoid this step.
 *
 * @param {*} streamQuery
 */
function normalizeStreamQuery (streamQuery) {
  if (streamQuery == null) return null;
  const res = [];
  for (const streamQueryItem of streamQuery) {
    res.push(normalizeStreamQueryItem(streamQueryItem));
  }
  return res;
}

function normalizeStreamQueryItem (streamQueryItem) {
  const normalizedStreamQuery = [];
  const not = []; // we need only one "not"
  if (streamQueryItem.any != null) normalizedStreamQuery.push({ any: streamQueryItem.any });
  if (streamQueryItem.not != null) not.push(...streamQueryItem.not);
  if (streamQueryItem.and != null) {
    for (const andItem of streamQueryItem.and) {
      if (andItem.any != null) normalizedStreamQuery.push({ any: andItem.any });
      if (andItem.not != null) addToNots(andItem.not);
    }
  }
  if (not.length > 0) normalizedStreamQuery.push({ not });
  return normalizedStreamQuery;

  function addToNots (notItems) {
    for (const item of notItems) {
      if (not.indexOf(item) === -1) not.push(item);
    }
  }
}

/**
 * Extract options from params
 */
function getStoreOptionsFromParams (params) {
  const options = {
    sortAscending: params.sortAscending,
    skip: params.skip,
    limit: params.limit
  };
  return options;
}

/**
 * Clean API query params to the store query format.
 * To be called on store-level params just before querying the store.
 * @param {object} params
 * @returns {object}
 */
function getStoreQueryFromParams (params) {
  const query = {
    state: params.state || 'default'
  };
  if (params.fromTime != null) { query.fromTime = params.fromTime; }
  if (params.toTime != null) { query.toTime = params.toTime; }
  if (params.streams != null) { query.streams = normalizeStreamQuery(params.streams); }
  if (params.types != null && params.types.length > 0) { query.types = params.types; }
  if (params.running != null) { query.running = params.running; }
  if (params.modifiedSince != null) { query.modifiedSince = params.modifiedSince; }
  return query;
}
