/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { fromCallback } = require('utils');
const Charlatan = require('charlatan');
const generateId = require('cuid');
const logger = require('@pryv/boiler').getLogger('databaseFixture');
const timestamp = require('unix-timestamp');
const { deepMerge } = require('utils');
const storage = require('storage'); // eslint-disable-line no-unused-vars -- used in JSDoc types
const Webhook = require('business').webhooks.Webhook;
const { getUsersRepository, User } = require('business/src/users/index.ts');
const integrityFinalCheck = require('test-helpers/src/integrity-final-check.ts');
const { getMall } = require('mall');

export default databaseFixture;
export { databaseFixture };

class Context {
  db;
  storageLayer;

  constructor (dbOrStorageLayer) {
    const { StorageLayer } = require('storage/src/StorageLayer.ts');
    if (dbOrStorageLayer instanceof StorageLayer) {
      this.storageLayer = dbOrStorageLayer;
      this.db = dbOrStorageLayer.connection;
    } else {
      this.db = dbOrStorageLayer;
    }
  }

  forUser (user) {
    return new UserContext(this, user);
  }

  async cleanEverything () {
    if (this.storageLayer) {
      // Engine-agnostic path via StorageLayer.clearCollection()
      for (const name of ['accesses', 'sessions', 'webhooks']) {
        await this.storageLayer.clearCollection(name);
      }
    } else {
      // Legacy raw DB path (MongoDB)
      const collectionNames = [
        'accesses',
        'sessions',
        'webhooks'
      ];
      for (const collectionName of collectionNames) {
        await fromCallback((cb) => this.db.deleteMany({ name: collectionName }, {}, cb));
      }
    }
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    await initMall();
  }
}

class UserContext {
  context;
  userName;
  user;

  constructor (context, userName) {
    this.context = context;
    this.userName = userName;
    // NOTE For simplicity of debugging, we'll assume that user.id ===
    // user.username.
    this.user = { id: userName, username: userName };
  }

  initStorage () {
    if (this.context.storageLayer) {
      // Engine-agnostic path via StorageLayer
      const sl = this.context.storageLayer;
      return {
        sessions: new SessionsFixture(sl.sessions),
        accesses: sl.accesses,
        webhooks: sl.webhooks
      };
    }
    // Legacy raw DB path (MongoDB)
    const db = this.context.db;
    const { Accesses: MongoAccesses } = require('storages/engines/mongodb/src/user/Accesses.ts');
    const { Webhooks: MongoWebhooks } = require('storages/engines/mongodb/src/user/Webhooks.ts');
    return {
      sessions: new Sessions(db),
      accesses: new MongoAccesses(db),
      webhooks: new MongoWebhooks(db)
    };
  }
}

class DependentsList {
  dependentItems;

  constructor () {
    this.dependentItems = [];
  }

  /**
   * Adds a dependent fixture item and creates it in the DB, before calling the given callback (`cb`) if any.
   * @template {FixtureItem} T
   * @param [cb]
   */
  async addAndCreate (fixtureItem, cb) {
    await fixtureItem.create();
    this.dependentItems.push(fixtureItem);
    if (cb) { cb(fixtureItem); }
    return fixtureItem;
  }

  hasItems () {
    return this.dependentItems.length > 0;
  }

  /**
   * Calls function for each dependent item, accumulating the promises returned by the function and
   * then returning a promise that only resolves once all individual promises
   * resolve (aka Promise.all).
   */
  all (fn) {
    return Promise.all(this.dependentItems.map(fn));
  }
}

class FixtureItem {
  dependents;
  context;
  storage;
  attrs;

  constructor (context, attrs) {
    this.dependents = new DependentsList();
    this.context = context;
    this.storage = this.context.initStorage();
    this.attrs = this.attributes(attrs);
  }

  hasDependents () {
    return this.dependents.hasItems();
  }

  /**
   * Merges attributes given with generated attributes and returns the
   * resulting attribute set.
   */
  attributes (attrs) {
    return deepMerge({
      id: generateId(),
      created: timestamp.now(),
      createdBy: this.context.user.id,
      modified: timestamp.now(),
      modifiedBy: this.context.user.id
    }, this.fakeAttributes(), attrs);
  }

  /**
   * Override this to provide default attributes via Charlatan generation.
   */
  fakeAttributes () {
    return {};
  }

  /**
   * Must be overridden.
   */
  async create () {
    throw new Error('Not implemented');
  }

  /**
   * To override if needed.
   */
  async remove () {
    throw new Error('Not implemented');
  }
}

class DatabaseFixture {
  dependents;
  context;

  constructor (context) {
    this.context = context;
    this.dependents = new DependentsList();
  }

  /**
   * Creates a Pryv user. If a callback is given (`cb`), it is called after
   * the user is created.
   */
  async user (name, attrs = {}, cb) {
    await initMall();
    const u = new FixtureUser(this.context.forUser(name), name, attrs);
    await u.remove();
    return await this.dependents.addAndCreate(u, cb);
  }

  /**
   * Cleans all created structures from the database. Usually, you would call
   * this in an afterEach function to ensure that the database is clean after
   * running tests.
   */
  async clean () {
    let integrityError;
    // In parallel mode the integrity check scans ALL data in the shared
    // database, including other workers' data, leading to false failures.
    if (process.env.DISABLE_INTEGRITY_CHECK !== '1') {
      try {
        // check integrity before reset — this could trigger error related to previous test
        await integrityFinalCheck.all();
      } catch (err) {
        integrityError = err; // keep it for later
      }
    }
    // clean data anyway
    const done = await this.dependents.all((fixtureItem) => {
      return fixtureItem.remove();
    });
    if (integrityError) {
      console.log(integrityError);
      // throw(integrityError);
    }
    return done;
  }
}

class FixtureUser extends FixtureItem {
  constructor (context, name, attrs) {
    super(context, deepMerge({
      id: name,
      username: name,
      storageUsed: 0,
      insurancenumber: Charlatan.Number.number(5),
      phoneNumber: Charlatan.Number.number(5)
    }, attrs));
  }

  stream (attrs: any = {}, cb?) {
    const s = new FixtureStream(this.context, attrs);
    return this.dependents.addAndCreate(s, cb);
  }

  event (attrs) {
    logger.debug('event', attrs);
    const e = new FixtureEvent(this.context, attrs);
    return this.dependents.addAndCreate(e);
  }

  access (attrs: any = {}) {
    const a = new FixtureAccess(this.context, attrs);
    return this.dependents.addAndCreate(a);
  }

  session (token) {
    const s = new FixtureSession(this.context, token);
    return this.dependents.addAndCreate(s);
  }

  webhook (attrs = {}, accessId) {
    const w = new FixtureWebhook(this.context, attrs, accessId);
    return this.dependents.addAndCreate(w);
  }

  /**
   * Removes all resources belonging to the user, then creates them again,
   * according to the spec stored here.
   */
  async create () {
    const attributes = this.attrs;
    const usersRepository = await getUsersRepository();
    const userObj = new User(attributes);
    await usersRepository.insertOne(userObj, false, true);
    return this.attrs;
  }

  async remove () {
    const username = this.context.userName;
    const usersRepository = await getUsersRepository();
    // Delete user FIRST while events still exist — deleteOne calls getUserById
    // which reads system-stream events (including email) so that
    // platform.deleteUser can properly clean up unique fields.
    // If dependents are removed first, getUserById returns null and unique
    // platform entries (e.g. email) are orphaned, causing integrity check failures.
    await usersRepository.deleteOne(this.context.user.id, username, true);
    // Then remove remaining dependents (accesses, webhooks,
    // sessions). Events and streams are already gone via mall.deleteUser inside
    // deleteOne; their individual remove() methods handle "not found" gracefully.
    await this.dependents.all((fixtureItem) => fixtureItem.remove());
  }

  fakeAttributes () {
    return {
      email: Charlatan.Internet.email(),
      password: Charlatan.Lorem.characters(10),
      language: 'fr'
    };
  }
}

class FixtureStream extends FixtureItem {
  parentId;

  constructor (context, attrs, parentId?) {
    if (parentId) {
      attrs.parentId = parentId;
    }
    super(context, attrs);
    this.parentId = attrs.parentId;
  }

  stream (attrs = {}, cb) {
    const s = new FixtureStream(this.context, attrs, this.attrs.id);
    return this.dependents.addAndCreate(s, cb);
  }

  event (attrs) {
    logger.debug('event', attrs);
    const e = new FixtureEvent(this.context, attrs, this.attrs.id);
    return this.dependents.addAndCreate(e);
  }

  async create () {
    const user = this.context.user;
    const attributes = this.attrs;
    return await mall.streams.create(user.id, attributes);
  }

  async remove () {
    // First remove all dependents (child streams and events)
    await this.dependents.all((fixtureItem) => fixtureItem.remove());
    // Then remove this stream
    const user = this.context.user;
    if (mall == null) { mall = await getMall(); }
    try {
      await mall.streams.delete(user.id, this.attrs.id);
    } catch (err: any) {
      // Ignore "stream not found" errors
      if (!err.message?.includes('unknown-resource')) throw err;
    }
  }

  fakeAttributes () {
    return {
      id: `c${Charlatan.Number.number(15)}`,
      name: Charlatan.Lorem.characters(10),
      parentId: this.parentId
    };
  }
}

class FixtureEvent extends FixtureItem {
  constructor (context, attrs, streamId?) {
    if (streamId) {
      // used by stream.event()
      super(context, { ...attrs, streamIds: [streamId] });
    } else {
      // streamIds must be provided by user.event()
      super(context, attrs);
    }
  }

  async create () {
    const user = this.context.user;
    const attributes = this.attrs;
    if (mall == null) { mall = await getMall(); }
    return await mall.events.create(user.id, attributes);
  }

  async remove () {
    const user = this.context.user;
    if (mall == null) { mall = await getMall(); }
    try {
      // mall.events.delete expects the event object
      await mall.events.delete(user.id, this.attrs);
    } catch (err: any) {
      // Ignore "event not found" errors
      if (!err.message?.includes('unknown-resource')) throw err;
    }
  }

  fakeAttributes () {
    // NOTE no need to worry about streamId, this is enforced by the
    // constructor.
    return {
      id: `c${Charlatan.Number.number(15)}`,
      time: Charlatan.Date.backward().getTime() / 1000,
      duration: 0,
      type: Charlatan.Helpers.sample(['mass/kg']),
      content: 90
    };
  }
}

class FixtureAccess extends FixtureItem {
  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = deepMerge(this.fakeAttributes(), this.attrs);
    return await fromCallback((cb) => storageItems.accesses.insertOne(user, attributes, cb));
  }

  async remove () {
    const storageItems = this.storage;
    const user = this.context.user;
    await fromCallback((cb) => storageItems.accesses.removeOne(user, { id: this.attrs.id }, cb));
  }

  fakeAttributes () {
    return {
      id: `c${Charlatan.Number.number(15)}`,
      token: Charlatan.Internet.deviceToken(),
      name: Charlatan.Internet.userName() + '-' + generateId(),
      type: Charlatan.Helpers.sample(['personal', 'shared'])
    };
  }
}

class FixtureWebhook extends FixtureItem {
  constructor (context, attrs, accessId) {
    super(context, { ...attrs, accessId });
  }

  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = this.attrs;
    const webhook = new Webhook(attributes).forStorage();
    return await fromCallback((cb) => storageItems.webhooks.insertOne(user, webhook, cb));
  }

  async remove () {
    const storageItems = this.storage;
    const user = this.context.user;
    await fromCallback((cb) => storageItems.webhooks.delete(user, { id: this.attrs.id }, cb));
  }

  fakeAttributes () {
    return {
      id: generateId(),
      url: `https://${Charlatan.Internet.domainName()}/notifications`
    };
  }
}

class FixtureSession extends FixtureItem {
  session;

  constructor (context, token) {
    const attrs: any = {};
    if (token != null) { attrs.id = token; }
    super(context, attrs);
  }

  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = this.attrs;
    return await fromCallback((cb) => storageItems.sessions.insertOne(user, attributes, cb));
  }

  async remove () {
    const storageItems = this.storage;
    // Session id is stored in attrs.id or attrs._id
    const sessionId = this.attrs.id || this.attrs._id;
    await fromCallback((cb) => storageItems.sessions.destroy(sessionId, cb));
  }

  fakeAttributes () {
    const twoWeeksMs = 1000 * 60 * 60 * 24 * 14;
    return {
      _id: generateId(),
      expires: new Date(Date.now() + twoWeeksMs),
      data: {
        username: this.context.user.username,
        appId: Charlatan.App.name()
      }
    };
  }
}

/**
 * Engine-agnostic fixture adapter for sessions.
 * Uses the Sessions interface (importAll + destroy) to insert/remove
 * sessions with specific ids, which the normal generate() method does not support.
 */
class SessionsFixture {
  sessions;

  constructor (sessions) {
    this.sessions = sessions;
  }

  insertOne (user, attributes, cb) {
    const doc = {
      _id: attributes.id || attributes._id,
      data: attributes.data,
      expires: attributes.expires
    };
    this.sessions.importAll([doc], cb);
  }

  destroy (id, cb) {
    this.sessions.destroy(id, cb);
  }
}

/**
 * A hack that allows session creation. The storage.Sessions interface
 * will not really allow fixture creation, so we're cloning some of the code
 * here.
 */
class Sessions {
  collectionInfo;
  db;

  constructor (db) {
    this.db = db;
    this.collectionInfo = {
      name: 'sessions',
      indexes: [
        // set TTL index for auto cleanup of expired sessions
        {
          index: { expires: 1 },
          options: { expireAfterSeconds: 0 }
        }
      ]
    };
  }

  /**
   * @param {{
   *       id: string;
   *     }} user
   */
  insertOne (user, attributes, cb) {
    const id = attributes.id;
    delete attributes.id;
    attributes._id = id;
    this.db.insertOne(this.collectionInfo, attributes, cb);
  }

  destroy (id, cb) {
    this.db.deleteOne(this.collectionInfo, { _id: id }, cb);
  }
}

function databaseFixture (dbOrStorageLayer) {
  const context = new Context(dbOrStorageLayer);
  return new DatabaseFixture(context);
}

let mall;
async function initMall () {
  if (mall == null) {
    mall = await getMall();
  }
}

type DatabaseShortcuts = {
  sessions: Sessions;
  // import('storage').user.X were JSDoc-only namespaced
  // types that don't translate to TS imports. These are storage layer instances.
  streams: any;
  accesses: any;
  webhooks: any;
};
type Attributes = {
  id: string;
  _id: string;
};
