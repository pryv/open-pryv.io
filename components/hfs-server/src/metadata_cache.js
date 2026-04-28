/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const async = require('async');
const bluebird = require('bluebird');
const { LRUCache: LRU } = require('lru-cache');
const logger = require('@pryv/boiler').getLogger('metadata_cache');
const storage = require('storage');
const MethodContext = require('business').MethodContext;
const errors = require('errors').factory;
const { SeriesRowType } = require('business').types;
const { pubsub } = require('messages');
const { getMall } = require('mall');
// A single HFS server will keep at maximum this many credentials in cache.
const LRU_CACHE_SIZE = 10000;
// Credentials will be cached for at most this many ms.
const LRU_CACHE_MAX_AGE_MS = 1000 * 60 * 5; // 5 mins
/** Holds metadata related to series for some time so that we don't have to
 * compile it every time we store data in the server.
 *
 * Caches data about a series first by `accessToken`, then by `eventId`.
 * */
class MetadataCache {
  loader;
  /**
   * Stores:
   *  - username/eventId -> [accessTokens]
   *  - accessToken -> username/eventID/accessToken
   *  - username/eventId/accessToken -> SeriesMetadataImpl (metadata_cache.js)
   */
  cache;

  series;

  mall;

  config;
  constructor (series, metadataLoader, config) {
    this.loader = metadataLoader;
    this.series = series;
    this.config = config;
    const options = {
      max: LRU_CACHE_SIZE,
      ttl: LRU_CACHE_MAX_AGE_MS
    };
    this.cache = new LRU(options);
    // messages
    this.subscribeToNotifications();
  }

  /**
   * @returns {Promise<void>}
   */
  async init () {
    this.mall = await getMall();
  }

  // transport messages
  /**
   * @param {UsernameEvent} usernameEvent
   * @returns {any}
   */
  dropSeries (usernameEvent) {
    return this.series.connection.dropMeasurement('event.' + usernameEvent.event.id, 'user.' + usernameEvent.username);
  }

  /**
   * @param {UsernameEvent} usernameEvent
   * @returns {void}
   */
  invalidateEvent (usernameEvent) {
    const cache = this.cache;
    const eventKey = usernameEvent.username + '/' + usernameEvent.event.id;
    const cachedTokenListForEvent = cache.get(eventKey);
    if (cachedTokenListForEvent != null) {
      // what does this return
      cachedTokenListForEvent.forEach((token) => {
        cache.delete(eventKey + '/' + token);
      });
    }
  }

  /**
   * @returns {void}
   */
  subscribeToNotifications () {
    pubsub.series.on(pubsub.SERIES_UPDATE_EVENTID_USERNAME, this.invalidateEvent.bind(this));
    pubsub.series.on(pubsub.SERIES_DELETE_EVENTID_USERNAME, this.dropSeries.bind(this));
  }

  // cache logic
  /**
   * @param {string} userName
   * @param {string} eventId
   * @param {string} accessToken
   * @returns {Promise<import("/Users/sim/Code/Pryv/dev/service-core/metadata_cache.ts-to-jsdoc").SeriesMetadata>}
   */
  async forSeries (userName, eventId, accessToken) {
    const cache = this.cache;
    const key = [userName, eventId, accessToken].join('/');
    // to make sure we update the tokenList "recently used info" cache we also get eventKey
    const eventKey = [userName, eventId].join('/');
    const cachedTokenListForEvent = cache.get(eventKey);
    // also keep a list of used Token to invalidate them
    const cachedEventListForTokens = cache.get(accessToken);
    const cachedValue = cache.get(key);
    if (cachedValue != null) {
      logger.debug(`Using cached credentials for ${userName} / ${eventId}.`);
      return cachedValue;
    }
    const newValue = await this.loader.forSeries(userName, eventId, accessToken);
    // new event we add it to the list
    if (cachedTokenListForEvent != null) {
      cache.set(eventKey, cachedTokenListForEvent.concat(accessToken));
    } else {
      cache.set(eventKey, [accessToken]);
    }
    // new token we add it to the list
    if (cachedEventListForTokens != null) {
      cache.set(accessToken, cachedEventListForTokens.concat(key));
    } else {
      cache.set(accessToken, [key]);
    }
    cache.set(key, newValue);
    return newValue;
  }
}
/** Loads metadata related to a series from the main database.
 */
class MetadataLoader {
  storage;

  mall;

  async init (mall, logger) {
    this.mall = mall;
    this.storage = await storage.getStorageLayer();
  }

  /**
   * @param {string} userName
   * @param {string} eventId
   * @param {string} accessToken
   * @returns {Promise<import("/Users/sim/Code/Pryv/dev/service-core/metadata_cache.ts-to-jsdoc").SeriesMetadata>}
   */
  forSeries (userName, eventId, accessToken) {
    const storage = this.storage;
    const mall = this.mall;
    // Retrieve Access (including accessLogic)
    const contextSource = {
      name: 'hf',
      ip: 'TODO'
    };
    const customAuthStep = null;
    const methodContext = new MethodContext(contextSource, userName, accessToken, customAuthStep);
    return bluebird.fromCallback((returnValueCallback) => {
      async.series([
        (next) => toCallback(methodContext.init(), next),
        (next) => toCallback(methodContext.retrieveExpandedAccess(storage), next),
        function loadEvent (done) {
          // result is used in success handler!
          const user = methodContext.user;
          mall.events.getOne(user.id, eventId).then((event) => {
            done(null, event);
          }, (err) => {
            done(err);
          });
        }
      ], (err, results) => {
        if (err != null) { return returnValueCallback(mapErrors(err)); }
        const access = methodContext.access;
        const user = methodContext.user;
        const event = results.at(-1);
        // Because we called retrieveExpandedAccess above.
        if (access == null) { throw new Error('AF: access != null'); }
        // Because we called retrieveUser above.
        if (user == null) { throw new Error('AF: user != null'); }
        if (event === null) { return returnValueCallback(errors.unknownResource('event', eventId)); }
        const serieMetadata = new SeriesMetadataImpl(access, user, event);
        serieMetadata.init().then(() => {
          returnValueCallback(null, serieMetadata);
        }, (error) => {
          returnValueCallback(error, serieMetadata);
        });
      });
    });
    function mapErrors (err) {
      if (!(err instanceof Error)) { return new Error(err); }
      // else
      return err;
    }
    function toCallback (promise, next) {
      return bluebird.resolve(promise).asCallback(next);
    }
  }
}
/** Metadata on a series, obtained from querying the main database.
 *
 * NOTE Instances of this class get stored in RAM for some time. This is the
 *  reason why we don't store everything about the event and the user here,
 *  only things that we subsequently need for our operations.
 */
class SeriesMetadataImpl {
  permissions;

  userName;

  eventId;

  eventType;

  time;

  trashed;

  deleted;

  _access;

  _event;
  constructor (access, user, event) {
    this._access = access;
    this._event = event;
    this.userName = user.username;
    this.eventId = event.id;
    this.time = event.time;
    this.eventType = event.type;
    this.trashed = event.trashed;
    this.deleted = event.deleted;
  }

  /**
   * @returns {Promise<void>}
   */
  async init () {
    this.permissions = await definePermissions(this._access, this._event);
  }

  /**
   * @returns {boolean}
   */
  isTrashedOrDeleted () {
    return this.trashed || this.deleted != null;
  }

  /**
   * @returns {boolean}
   */
  canWrite () {
    return this.permissions.write;
  }

  /**
   * @returns {boolean}
   */
  canRead () {
    return this.permissions.read;
  }

  /**
   * @returns {[string, string]}
   */
  namespaceAndName () {
    return [`user.${this.userName}`, `event.${this.eventId}`];
  }

  // Return the InfluxDB row type for the given event.
  /**
   * @param {TypeRepository} repo
   * @returns {any}
   */
  produceRowType (repo) {
    const type = repo.lookup(this.eventType);

    // TODO review this now that flow is gone:
    // NOTE The instanceof check here serves to make flow-type happy about the
    //  value we'll return from this function. If duck-typing via 'isSeries' is
    //  ever needed, you'll need to find a different way of providing the same
    //  static guarantee (think interfaces...).
    if (!type.isSeries() || !(type instanceof SeriesRowType)) { throw errors.invalidOperation("High Frequency data can only be stored in events whose type starts with 'series:'."); }
    type.setSeriesMeta(this);
    return type;
  }
}
/**
 * @param {AccessModel} access
 * @param {EventModel} event
 * @returns {{ write: boolean; read: boolean; }}
 */
async function definePermissions (access, event) {
  const streamIds = event.streamIds;
  const permissions = {
    write: false,
    read: false
  };
  const streamIdsLength = streamIds.length;
  for (let i = 0; i < streamIdsLength && !readAndWriteTrue(permissions); i++) {
    if (await access.canCreateEventsOnStream(streamIds[i])) { permissions.write = true; }
    if (await access.canGetEventsOnStream(streamIds[i], 'local')) { permissions.read = true; }
  }
  return permissions;
  function readAndWriteTrue (permissions) {
    return permissions.write === true && permissions.read === true;
  }
}
module.exports = {
  MetadataLoader,
  MetadataCache
};

/**
 * @typedef {{
 *   username: string;
 *   event: {
 *     id: string;
 *   };
 * }} UsernameEvent
 */

/**
 * @typedef {{
 *   canCreateEventsOnStream(streamId: string): boolean;
 *   canGetEventsOnStream(streamId: string, storeId: string): boolean;
 * }} AccessModel
 */

/**
 * @typedef {{
 *   id: string;
 *   streamIds: string;
 *   type: string;
 *   time: number;
 *   trashed: boolean;
 *   deleted: number;
 * }} EventModel
 */

/**
 * @typedef {{
 *   id: string;
 *   username: string;
 * }} UserModel
 */

/** A repository for meta data on series.
 * @typedef {Object} MetadataRepository
 */

/** Meta data on series.
 * @typedef {Object} SeriesMetadata
 */
