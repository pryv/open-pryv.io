/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

/**
 * “Data stores aggregator”.
 * Provides a uniform interface to all data stores (built-in and custom).
 */

const { setTimeout } = require('timers/promises');
const { getConfig, getLogger } = require('@pryv/boiler');
const Mall = require('./Mall');

module.exports = {
  getMall,
  // TODO: eventually remove this once all the store id logic is safely contained within the mall
  storeDataUtils: require('./helpers/storeDataUtils')
};

let mall;
let initializing = false;

/**
 * @returns {Promise<any>}
 */
async function getMall () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (initializing) {
    await setTimeout(5);
  }
  if (mall != null) { return mall; }
  initializing = true;

  const config = await getConfig();
  const logger = getLogger('mall');
  mall = new Mall();

  // load external stores from config (imported after to avoid cycles);
  const customStoresDef = config.get('custom:dataStores');
  if (customStoresDef) {
    for (const storeDef of customStoresDef) {
      logger.info(`Loading store "${storeDef.name}" with id "${storeDef.id}" from ${storeDef.path}`);
      const store = require(storeDef.path);
      const storeDescription = {
        id: storeDef.id,
        name: storeDef.name,
        includeInStarPermission: true,
        settings: storeDef.settings
      };
      mall.addStore(store, storeDescription);
    }
  }

  // Load built-in data store from storages barrel
  const storages = require('storages');
  await storages.init(config);
  const dataStoreModule = storages.dataStoreModule;
  const localSettings = {
    attachments: { setFileReadToken: true },
    versioning: config.get('versioning')
  };
  mall.addStore(dataStoreModule, { id: 'local', name: 'Local', settings: localSettings });
  // account (system streams backed by baseStorage account fields)
  const accountStore = require('storages/datastores/account');
  mall.addStore(accountStore, { id: 'account', name: 'Account', settings: {} });

  // audit
  if (config.get('audit:active')) {
    const auditDataStore = require('audit/src/datastore/auditDataStore');
    mall.addStore(auditDataStore, { id: '_audit', name: 'Audit', settings: {} });
  }

  await mall.init();

  initializing = false;
  return mall;
}

/** @typedef {Class<import>} DataStore */
