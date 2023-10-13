/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const bluebird = require('bluebird');
const Charlatan = require('charlatan');
const generateId = require('cuid');
const logger = require('@pryv/boiler').getLogger('databaseFixture');
const timestamp = require('unix-timestamp');
const _ = require('lodash');
const storage = require('storage');
const Webhook = require('business').webhooks.Webhook;
const { getUsersRepository, User } = require('business/src/users');
const integrityFinalCheck = require('test-helpers/src/integrity-final-check');
const { getMall } = require('mall');

module.exports = databaseFixture;

class Context {
  /**
   * @type {import('storage').Database}
   */
  db;

  constructor (db) {
    this.db = db;
  }

  /**
   * @param {string} user
   * @returns {UserContext}
   */
  forUser (user) {
    return new UserContext(this, user);
  }

  /**
   * @returns {Promise<void>}
   */
  async cleanEverything () {
    const collectionNames = [
      'accesses',
      'sessions',
      'followedSlices',
      'webhooks',
      'versions'
    ];
    for (const collectionName of collectionNames) {
      await bluebird.fromCallback((cb) => this.db.deleteMany({ name: collectionName }, {}, cb));
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
    this.user = { id: userName };
  }

  /**
   * @returns {{ sessions: Sessions; accesses: any; webhooks: any; }}
   */
  initStorage () {
    const db = this.context.db;
    return {
      sessions: new Sessions(db),
      accesses: new storage.user.Accesses(db),
      webhooks: new storage.user.Webhooks(db)
    };
  }
}

class DependentsList {
  /**
   * @type {FixtureItem[]}
   */
  dependentItems;

  constructor () {
    this.dependentItems = [];
  }

  /**
   * Adds a dependent fixture item and creates it in the DB, before calling the given callback (`cb`) if any.
   * @template {FixtureItem} T
   * @param {T} fixtureItem
   * @param {(a: T) => unknown} [cb]
   * @returns {Promise<T>}
   */
  async addAndCreate (fixtureItem, cb) {
    await fixtureItem.create();
    this.dependentItems.push(fixtureItem);
    if (cb) { cb(fixtureItem); }
    return fixtureItem;
  }

  /**
   * @returns {boolean}
   */
  hasItems () {
    return this.dependentItems.length > 0;
  }

  /**
   * Calls function for each dependent item, accumulating the promises returned by the function and
   * then returning a promise that only resolves once all individual promises
   * resolve (aka Promise.all).
   * @param {(a: FixtureItem) => Promise<FixtureItem>} fn
   * @returns {Promise<FixtureItem[]>}
   */
  all (fn) {
    return bluebird.map(this.dependentItems, fn);
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

  /**
   * @returns {boolean}
   */
  hasDependents () {
    return this.dependents.hasItems();
  }

  /**
   * Merges attributes given with generated attributes and returns the
   * resulting attribute set.
   * @param {{}} attrs
   * @returns {Attributes}
   */
  attributes (attrs) {
    return _.merge({
      id: generateId(),
      created: timestamp.now(),
      createdBy: this.context.user.id,
      modified: timestamp.now(),
      modifiedBy: this.context.user.id
    }, this.fakeAttributes(), attrs);
  }

  /**
   * Override this to provide default attributes via Charlatan generation.
   * @returns {{}}
   */
  fakeAttributes () {
    return {};
  }

  /**
   * Must be overridden.
   * @returns {Promise<any>}
   */
  async create () {
    throw new Error('Not implemented');
  }

  /**
   * To override if needed.
   * @returns {Promise<any>}
   */
  async remove () {
    throw new Error('Not implemented');
  }
}

class DatabaseFixture {
  dependents;
  /**
   * @type {Context}
   */
  context;

  constructor (context) {
    this.context = context;
    this.dependents = new DependentsList();
  }

  /**
   * Creates a Pryv user. If a callback is given (`cb`), it is called after
   * the user is created.
   * @param {string} name
   * @param {{}} attrs
   * @param {(a: FixtureUser) => unknown} cb
   * @returns {Promise<FixtureUser>}
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
   * @returns {Promise<unknown>}
   */
  async clean () {
    let integrityError;
    try {
      // check integrity before reset--- This could trigger error related to previous test
      await integrityFinalCheck.all();
    } catch (err) {
      integrityError = err; // keep it for later
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
    super(context, _.merge({
      id: name,
      username: name,
      storageUsed: 0,
      insurancenumber: Charlatan.Number.number(5),
      phoneNumber: Charlatan.Number.number(5)
    }, attrs));
  }

  /**
   * @param {{}} attrs
   * @param {(a: FixtureStream) => void} cb
   * @returns {Promise<FixtureStream>}
   */
  stream (attrs = {}, cb) {
    const s = new FixtureStream(this.context, attrs);
    return this.dependents.addAndCreate(s, cb);
  }

  /**
   * @param {{}} attrs
   * @returns {Promise<FixtureEvent>}
   */
  event (attrs) {
    logger.debug('event', attrs);
    const e = new FixtureEvent(this.context, attrs);
    return this.dependents.addAndCreate(e);
  }

  /**
   * @param {{}} attrs
   * @returns {Promise<FixtureAccess>}
   */
  access (attrs = {}) {
    const a = new FixtureAccess(this.context, attrs);
    return this.dependents.addAndCreate(a);
  }

  /**
   * @param {string} token
   * @returns {Promise<FixtureSession>}
   */
  session (token) {
    const s = new FixtureSession(this.context, token);
    return this.dependents.addAndCreate(s);
  }

  /**
   * @param {{}} attrs
   * @param {string} accessId
   * @returns {Promise<FixtureWebhook>}
   */
  webhook (attrs = {}, accessId) {
    const w = new FixtureWebhook(this.context, attrs, accessId);
    return this.dependents.addAndCreate(w);
  }

  /**
   * Removes all resources belonging to the user, then creates them again,
   * according to the spec stored here.
   * @returns {Promise<any>}
   */
  async create () {
    const attributes = this.attrs;
    const usersRepository = await getUsersRepository();
    const userObj = new User(attributes);
    await usersRepository.insertOne(userObj, false, true);
    return this.attrs;
  }

  /**
   * @returns {Promise<FixtureUser>}
   */
  async remove () {
    const storageItems = this.storage;
    const username = this.context.userName;
    const collections = [storageItems.accesses, storageItems.webhooks];
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteOne(this.context.user.id, username, true);
    const removeSessions = await bluebird.fromCallback((cb) => storageItems.sessions.removeForUser(username, cb));
    return await bluebird
      .all([removeSessions])
      .then(() => bluebird.map(collections, (coll) => this.safeRemoveColl(coll)));
  }

  /**
   * @returns {Promise<void>}
   */
  async safeRemoveColl (collection) {
    const user = this.context.user;
    try {
      await bluebird.fromCallback((cb) => collection.dropCollection(user, cb));
    } catch (err) {
      if (!/ns not found/.test(err.message)) { throw err; }
    }
  }

  /**
   * @returns {{ email: any; password: any; language: string; }}
   */
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

  constructor (context, attrs, parentId) {
    if (parentId) {
      attrs.parentId = parentId;
    }
    super(context, attrs);
    this.parentId = attrs.parentId;
  }

  /**
   * @param {{}} attrs
   * @param {(a: FixtureStream) => void} cb
   * @returns {Promise<FixtureStream>}
   */
  stream (attrs = {}, cb) {
    const s = new FixtureStream(this.context, attrs, this.attrs.id);
    return this.dependents.addAndCreate(s, cb);
  }

  /**
   * @param {{}} attrs
   * @returns {Promise<FixtureEvent>}
   */
  event (attrs) {
    logger.debug('event', attrs);
    const e = new FixtureEvent(this.context, attrs, this.attrs.id);
    return this.dependents.addAndCreate(e);
  }

  /**
   * @returns {Promise<any>}
   */
  async create () {
    const user = this.context.user;
    const attributes = this.attrs;
    return await mall.streams.create(user.id, attributes);
  }

  /**
   * @returns {{ id: string; name: any; parentId: string; }}
   */
  fakeAttributes () {
    return {
      id: `c${Charlatan.Number.number(15)}`,
      name: Charlatan.Lorem.characters(10),
      parentId: this.parentId
    };
  }
}

class FixtureEvent extends FixtureItem {
  constructor (context, attrs, streamId) {
    if (streamId) {
      // used by stream.event()
      super(context, { ...attrs, streamIds: [streamId] });
    } else {
      // streamIds must be provided by user.event()
      super(context, attrs);
    }
  }

  /**
   * @returns {Promise<any>}
   */
  async create () {
    const user = this.context.user;
    const attributes = this.attrs;
    if (mall == null) { mall = await getMall(); }
    return await mall.events.create(user.id, attributes);
  }

  /**
   * @returns {{ id: string; time: number; duration: number; type: any; tags: any[]; content: number; }}
   */
  fakeAttributes () {
    // NOTE no need to worry about streamId, this is enforced by the
    // constructor.
    return {
      id: `c${Charlatan.Number.number(15)}`,
      time: Charlatan.Date.backward().getTime() / 1000,
      duration: 0,
      type: Charlatan.Helpers.sample(['mass/kg']),
      tags: [],
      content: 90
    };
  }
}

class FixtureAccess extends FixtureItem {
  /**
   * @returns {Promise<any>}
   */
  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = _.merge(this.fakeAttributes(), this.attrs);
    return await bluebird.fromCallback((cb) => storageItems.accesses.insertOne(user, attributes, cb));
  }

  /**
   * @returns {{ id: string; token: any; name: any; type: any; }}
   */
  fakeAttributes () {
    return {
      id: `c${Charlatan.Number.number(15)}`,
      token: Charlatan.Internet.deviceToken(),
      name: Charlatan.Internet.userName(),
      type: Charlatan.Helpers.sample(['personal', 'shared'])
    };
  }
}

class FixtureWebhook extends FixtureItem {
  constructor (context, attrs, accessId) {
    super(context, { ...attrs, accessId });
  }

  /**
   * @returns {Promise<any>}
   */
  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = this.attrs;
    const webhook = new Webhook(attributes).forStorage();
    return await bluebird.fromCallback((cb) => storageItems.webhooks.insertOne(user, webhook, cb));
  }

  /**
   * @returns {{ id: any; url: string; }}
   */
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
    const attrs = {};
    if (token != null) { attrs.id = token; }
    super(context, attrs);
  }

  /**
   * @returns {Promise<any>}
   */
  async create () {
    const storageItems = this.storage;
    const user = this.context.user;
    const attributes = this.attrs;
    return await bluebird.fromCallback((cb) => storageItems.sessions.insertOne(user, attributes, cb));
  }

  /**
   * @returns {{ _id: any; expires: any; data: { username: any; appId: any; }; }}
   */
  fakeAttributes () {
    const getNewExpirationDate = storage.Sessions.prototype.getNewExpirationDate.bind({
      options: {
        maxAge: 1000 * 60 * 60 * 24 * 14 // two weeks
      }
    });
    return {
      _id: generateId(),
      expires: getNewExpirationDate(),
      data: {
        username: this.context.user.username,
        appId: Charlatan.App.name()
      }
    };
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
   * @param {Attributes} attributes
   * @param {() => void} cb
   * @returns {void}
   */
  insertOne (user, attributes, cb) {
    const id = attributes.id;
    delete attributes.id;
    attributes._id = id;
    this.db.insertOne(this.collectionInfo, attributes, cb);
  }

  /**
   * @param {string} userName
   * @param {() => void} cb
   * @returns {void}
   */
  removeForUser (userName, cb) {
    this.db.deleteMany(this.collectionInfo, { 'data.username': userName }, cb);
  }
}

/**
 * @param {import('storage').Database} database
 * @returns {DatabaseFixture}
 */
function databaseFixture (database) {
  const context = new Context(database);
  return new DatabaseFixture(context);
}

let mall;
/**
 * @returns {Promise<void>}
 */
async function initMall () {
  if (mall == null) {
    mall = await getMall();
  }
}

/**
 * @typedef {{
 *   sessions: Sessions;
 *   streams: import('storage').user.Streams;
 *   accesses: import('storage').user.Accesses;
 *   webhooks: import('storage').user.Webhooks;
 * }} DatabaseShortcuts
 */

/**
 * @typedef {{
 *   id: string;
 *   _id: string;
 * }} Attributes
 */
