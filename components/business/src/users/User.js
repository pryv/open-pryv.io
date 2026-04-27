/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const cuid = require('cuid');
const accountStreams = require('business/src/system-streams');

function pick (obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

class User {
  // User properties that exists by default (email could not exist with specific config)

  id;

  username;

  email;

  language;

  password;

  accessId;

  events;
  /** @default [] */
  accountFields = [];
  /** @default [] */
  readableAccountFields = [];
  /** @default [] */
  accountFieldsWithPrefix = [];
  /** @default [] */
  uniqueAccountFields = [];
  constructor (params) {
    this.username = params.username;
    buildAccountFields(this);
    loadAccountData(this, params);
    if (params.events != null) { this.events = buildAccountDataFromListOfEvents(this, params.events); }
    this.createIdIfMissing();
  }

  /**
   * @returns {void}
   */
  createIdIfMissing () {
    if (this.id == null) { this.id = cuid(); }
  }

  /**
   * Get only readable account information
   * @returns {{}}
   */
  getReadableAccount () {
    return pick(this, this.readableAccountFields.filter((x) => x !== 'dbDocuments' && x !== 'attachedFiles'));
  }

  /**
   * Get full account information
   * @returns {{}}
   */
  getFullAccount () {
    return pick(this, this.accountFields.filter((x) => x !== 'dbDocuments' && x !== 'attachedFiles'));
  }

  /**
   * Get fields provided by account methods
   * @returns {{}}
   */
  getLegacyAccount () {
    return pick(this, ['username', 'email', 'language', 'storageUsed']);
  }

  /**
   * Get account with id property added to it
   * @returns {any}
   */
  getAccountWithId () {
    const res = pick(this, this.accountFields
      .concat('id')
      .filter((x) => x !== 'dbDocuments' && x !== 'attachedFiles'));
    res.username = this.username;
    return res;
  }
}
/**
 * @param {User} user
 * @returns {void}
 */
function buildAccountFields (user) {
  const accountMap = accountStreams.accountMap;
  user.accountFieldsWithPrefix = [];
  user.uniqueAccountFields = [];
  user.readableAccountFields = [];
  user.accountFields = [];
  for (const [streamId, stream] of Object.entries(accountMap)) {
    user.accountFieldsWithPrefix.push(streamId);
    const withoutPrefix = accountStreams.toFieldName(streamId);
    if (stream.isUnique === true) user.uniqueAccountFields.push(withoutPrefix);
    if (stream.isShown === true) user.readableAccountFields.push(withoutPrefix);
    user.accountFields.push(withoutPrefix);
  }
}
/**
 * @param {User} user
 * @returns {void}
 */
function loadAccountData (user, params) {
  user.accountFields.forEach((field) => {
    if (field === 'dbDocuments' || field === 'attachedFiles') {
      // These are computed by Size.js, not stored as account fields
    } else {
      if (params[field] != null) { user[field] = params[field]; }
    }
  });
  if (params.password) {
    user.password = params.password;
  }
  if (params.id) {
    user.id = params.id;
  }
}
/**
 * Assign events data to user account fields
 * @param {User} user
 * @param {Array<Event>} events
 * @returns {any[]}
 */
function buildAccountDataFromListOfEvents (user, events) {
  const account = buildAccountRecursive(accountStreams.accountChildren, events, {});
  Object.keys(account).forEach((param) => {
    user[param] = account[param];
  });
  return events;
}
/**
 * Takes the list of the streams, events list
 * and object where events will be saved in a tree structure
 * @param object streams
 * @param array events
 * @param object user
 * @param {Array<SystemStream>} streams
 * @param {Array<Event>} events
 * @param {{}} user
 * @returns {User}
 */
function buildAccountRecursive (streams, events, user) {
  let streamIndex;
  for (streamIndex = 0; streamIndex < streams.length; streamIndex++) {
    const currentStream = streams[streamIndex];
    const streamIdWithPrefix = currentStream.id;
    const streamIdWithoutPrefix = accountStreams.toFieldName(streamIdWithPrefix);
    // if stream has children recursivelly call the same function
    if (Array.isArray(currentStream.children) &&
            currentStream.children.length > 0) {
      user[streamIdWithoutPrefix] = {};
      user[streamIdWithoutPrefix] = buildAccountRecursive(currentStream.children, events, user[streamIdWithoutPrefix]);
    }
    // get value for the stream element
    for (let i = 0; i < events.length; i++) {
      if (events[i].streamIds.includes(streamIdWithPrefix)) {
        user[streamIdWithoutPrefix] = events[i].content;
        break;
      }
    }
  }
  return user;
}
module.exports = User;
