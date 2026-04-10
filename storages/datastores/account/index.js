/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account DataStore adapter.
 *
 * Thin pryv-datastore wrapping baseStorage's account fields.
 * Exposes account metadata (email, language, phone, etc.) as streams/events
 * through the standard Mall DataStore interface.
 *
 * Stream tree comes from system streams config (read-only).
 * Events map to account fields in userAccountStorage.
 *
 * Usage:
 *   const accountStore = require('storages/datastores/account');
 *   mall.addStore(accountStore, { id: 'account', name: 'Account', settings: { streamTree } });
 *   // streamTree is the system streams array from config
 */

const ds = require('@pryv/datastore');
const AccountUserStreams = require('./AccountUserStreams');
const AccountUserEvents = require('./AccountUserEvents');

let userAccountStorage = null;
let fieldStreamMap = null;

module.exports = ds.createDataStore({
  async init (params) {
    const { settings } = params;
    if (!settings || !settings.streamTree) {
      throw new Error('accountStore requires settings.streamTree (system streams config)');
    }

    // Clone the stream tree — AccountUserStreams.cleanStreamTree() mutates in place
    const streamTree = structuredClone(settings.streamTree);

    // Build the field → stream config map from the original (pre-clean) tree
    fieldStreamMap = buildFieldStreamMap(streamTree);

    // Lazy accessor for userAccountStorage (avoids circular deps)
    const getStorage = async () => {
      if (!userAccountStorage) {
        const { getUserAccountStorage } = require('storage');
        userAccountStorage = await getUserAccountStorage();
      }
      return userAccountStorage;
    };

    // AccountUserStreams gets its own copy (it mutates via cleanStreamTree)
    this.streams = AccountUserStreams.create(structuredClone(streamTree));
    this.events = AccountUserEvents.create(fieldStreamMap, getStorage);

    return this;
  },

  streams: null,
  events: null,

  async deleteUser (userId) {
    if (userAccountStorage) {
      await userAccountStorage._clearAll(userId);
    }
  },

  async getUserStorageInfos (userId) {
    return {};
  }
});

/**
 * Build a map of fieldName → stream config for all leaf streams
 * (streams that represent actual account fields, not parent containers).
 *
 * A leaf stream is one that has a type other than 'none/none' and no children
 * (or empty children array).
 *
 * @param {Array} streamTree
 * @returns {Map<string, object>}
 */
function buildFieldStreamMap (streamTree) {
  const map = new Map();
  collectLeaves(streamTree);
  return map;

  function collectLeaves (streams) {
    for (const s of streams) {
      if (s.children && s.children.length > 0) {
        collectLeaves(s.children);
      }
      if (s.type !== 'none/none') {
        // Extract unprefixed field name from stream id
        // ':_system:email' → 'email', ':system:phone' → 'phone'
        const fieldName = extractFieldName(s.id);
        map.set(fieldName, s);
      }
    }
  }
}

/**
 * Extract the unprefixed field name from a system stream ID.
 * ':_system:email' → 'email'
 * ':system:phone' → 'phone'
 * 'email' → 'email' (already unprefixed)
 */
function extractFieldName (streamId) {
  const lastColon = streamId.lastIndexOf(':');
  if (lastColon >= 0) {
    return streamId.substring(lastColon + 1);
  }
  return streamId;
}
