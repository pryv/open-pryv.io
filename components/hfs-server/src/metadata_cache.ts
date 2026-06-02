/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { fromCallback } = require('utils');
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
  loader: MetadataLoader;
  // Stores:
  //  - username/eventId -> [accessTokens]
  //  - accessToken -> [username/eventId/accessToken, ...]
  //  - username/eventId/accessToken -> SeriesMetadataImpl
  cache: InstanceType<typeof LRU>;

  series: any; // SeriesConnection — not yet typed.

  mall: any;

  config: any;
  constructor (series: any, metadataLoader: MetadataLoader, config: any) {
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

  async init () {
    this.mall = await getMall();
  }

  // transport messages
  dropSeries (usernameEvent: UsernameEvent) {
    return this.series.connection.dropMeasurement('event.' + usernameEvent.event.id, 'user.' + usernameEvent.username);
  }

  invalidateEvent (usernameEvent: UsernameEvent) {
    const cache = this.cache;
    const eventKey = usernameEvent.username + '/' + usernameEvent.event.id;
    const cachedTokenListForEvent = cache.get(eventKey) as string[] | undefined;
    if (cachedTokenListForEvent != null) {
      // what does this return
      cachedTokenListForEvent.forEach((token: string) => {
        cache.delete(eventKey + '/' + token);
      });
    }
  }

  subscribeToNotifications () {
    pubsub.series.on(pubsub.SERIES_UPDATE_EVENTID_USERNAME, this.invalidateEvent.bind(this));
    pubsub.series.on(pubsub.SERIES_DELETE_EVENTID_USERNAME, this.dropSeries.bind(this));
  }

  // cache logic
  async forSeries (userName: string, eventId: string, accessToken: string) {
    const cache = this.cache;
    const key = [userName, eventId, accessToken].join('/');
    // to make sure we update the tokenList "recently used info" cache we also get eventKey
    const eventKey = [userName, eventId].join('/');
    const cachedTokenListForEvent = cache.get(eventKey) as string[] | undefined;
    // also keep a list of used Token to invalidate them
    const cachedEventListForTokens = cache.get(accessToken) as string[] | undefined;
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
  storage: any;

  mall: any;

  async init (mall: unknown, _logger: unknown) {
    this.mall = mall;
    this.storage = await storage.getStorageLayer();
  }

  forSeries (userName: string, eventId: string, accessToken: string) {
    const storage = this.storage;
    const mall = this.mall;
    // Retrieve Access (including accessLogic)
    const contextSource = {
      name: 'hf',
      // TODO(B-2026-05-27-9, 2026-05-27): pass real client IP from express req — currently emits literal 'TODO' into audit context
      ip: 'TODO'
    };
    const customAuthStep = null;
    const methodContext = new MethodContext(contextSource, userName, accessToken, customAuthStep);
    return fromCallback(async (returnValueCallback: (err: unknown, value?: unknown) => void) => {
      try {
        await methodContext.init();
        await methodContext.retrieveExpandedAccess(storage);
        const user = methodContext.user;
        const event = await mall.events.getOne(user.id, eventId);
        const access = methodContext.access;
        // Because we called retrieveExpandedAccess above.
        if (access == null) { throw new Error('AF: access != null'); }
        // Because user was retrieved above.
        if (user == null) { throw new Error('AF: user != null'); }
        if (event === null) { return returnValueCallback(errors.unknownResource('event', eventId)); }
        const serieMetadata = new SeriesMetadataImpl(access, user, event);
        serieMetadata.init().then(() => {
          returnValueCallback(null, serieMetadata);
        }, (error: unknown) => {
          returnValueCallback(error, serieMetadata);
        });
      } catch (err) {
        returnValueCallback(mapErrors(err));
      }
    });
    function mapErrors (err: unknown): Error {
      if (!(err instanceof Error)) { return new Error(String(err)); }
      // else
      return err;
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
  permissions!: { write: boolean; read: boolean };

  userName: string;

  eventId: string;

  eventType: string;

  time: number;

  trashed: boolean;

  deleted: number | null;

  _access: AccessModel;

  _event: EventModel;
  constructor (access: AccessModel, user: UserModel, event: EventModel) {
    this._access = access;
    this._event = event;
    this.userName = user.username;
    this.eventId = event.id;
    this.time = event.time;
    this.eventType = event.type;
    this.trashed = event.trashed;
    this.deleted = event.deleted;
  }

  async init () {
    this.permissions = await definePermissions(this._access, this._event);
  }

  isTrashedOrDeleted () {
    return this.trashed || this.deleted != null;
  }

  canWrite () {
    return this.permissions.write;
  }

  canRead () {
    return this.permissions.read;
  }

  namespaceAndName () {
    return [`user.${this.userName}`, `event.${this.eventId}`];
  }

  // Return the InfluxDB row type for the given event.
  produceRowType (repo: { lookup (type: string): any }) {
    const type = repo.lookup(this.eventType);

    // NOTE: the instanceof check here serves to make the type system happy
    // about the value we return. If duck-typing via 'isSeries' is ever
    // needed, you'll need a different way of providing the same static
    // guarantee (think interfaces...).
    if (!type.isSeries() || !(type instanceof SeriesRowType)) { throw errors.invalidOperation("High Frequency data can only be stored in events whose type starts with 'series:'."); }
    type.setSeriesMeta(this);
    return type;
  }
}
async function definePermissions (access: AccessModel, event: EventModel) {
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
  function readAndWriteTrue (permissions: { write: boolean; read: boolean }) {
    return permissions.write === true && permissions.read === true;
  }
}
export { MetadataLoader, MetadataCache };

type UsernameEvent = {
  username: string;
  event: {
  id: string;
  };
};
type AccessModel = {
  canCreateEventsOnStream(streamId: string): Promise<boolean>;
  canGetEventsOnStream(streamId: string, storeId: string): Promise<boolean>;
};
type EventModel = {
  id: string;
  streamIds: string[];
  type: string;
  time: number;
  trashed: boolean;
  deleted: number | null;
};
type UserModel = {
  id: string;
  username: string;
};
/** A repository for meta data on series.
 * @typedef {Object} MetadataRepository
 */

/** Meta data on series.
 * @typedef {Object} SeriesMetadata
 */
