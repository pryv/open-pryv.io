/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';

import type MallType from './Mall.ts';
const require = createRequire(import.meta.url);

/**
 * “Data stores aggregator”.
 * Provides a uniform interface to all data stores (built-in and custom).
 */

const { setTimeout } = require('timers/promises');
const { getConfig, getLogger } = require('@pryv/boiler');
const Mall = require('./Mall.ts').default;
const storeDataUtils = require('./helpers/storeDataUtils.ts');

export { getMall, storeDataUtils, planCustomStores, BUILT_IN_STORE_IDS };

/** Ids of the stores the mall registers itself. */
const BUILT_IN_STORE_IDS = ['local', 'account', '_audit'];

type CustomStoreDef = { id: string; name: string; path: string; settings?: unknown; override?: boolean };

/**
 * Sort the `custom:dataStores` entries: `before` are registered ahead of the built-in
 * stores, as additional stores (covered by a `*` permission); `replacing` are registered
 * after them and replace the built-in store of the same id (`override: true`; like the
 * built-in they replace, not covered by `*`); `ignored` use a built-in id without
 * `override: true` and are not registered (the built-in store keeps the id).
 */
function planCustomStores (defs: CustomStoreDef[] | null | undefined): { before: CustomStoreDef[]; replacing: CustomStoreDef[]; ignored: CustomStoreDef[] } {
  const plan = { before: [] as CustomStoreDef[], replacing: [] as CustomStoreDef[], ignored: [] as CustomStoreDef[] };
  for (const def of defs ?? []) {
    if (!BUILT_IN_STORE_IDS.includes(def.id)) plan.before.push(def);
    else if (def.override === true) plan.replacing.push(def);
    else plan.ignored.push(def);
  }
  return plan;
}

let mall: MallType | undefined;
let initializing = false;

async function getMall () {
  // eslint-disable-next-line no-unmodified-loop-condition
  while (initializing) {
    await setTimeout(5);
  }
  if (mall != null) { return mall; }
  initializing = true;
  try {
    return await buildMall();
  } catch (err) {
    // Init failed: drop the half-built instance so a later call rebuilds it
    // instead of returning (or caching) a partial mall.
    mall = undefined;
    throw err;
  } finally {
    // ALWAYS clear the guard. Without this a failed init would leave
    // `initializing = true` forever, stranding every future getMall() caller
    // in the spin loop above.
    initializing = false;
  }
}

async function buildMall () {
  const config = await getConfig();
  const logger = getLogger('mall');
  const newMall: MallType = new Mall();
  mall = newMall;

  // load external stores from config (imported after to avoid cycles);
  const plan = planCustomStores(config.get('custom:dataStores'));
  const addCustomStore = (storeDef: CustomStoreDef, includeInStarPermission: boolean) => {
    const storeMod = require(storeDef.path);
    const store = storeMod.default ?? storeMod;
    newMall.addStore(store, {
      id: storeDef.id,
      name: storeDef.name,
      includeInStarPermission,
      settings: storeDef.settings
    });
  };
  for (const storeDef of plan.ignored) {
    logger.warn(`Store "${storeDef.name}" from ${storeDef.path} uses the id "${storeDef.id}" of a built-in store and is not loaded: set "override: true" on its custom:dataStores entry to replace the built-in store`);
  }
  for (const storeDef of plan.before) {
    logger.info(`Loading store "${storeDef.name}" with id "${storeDef.id}" from ${storeDef.path}`);
    addCustomStore(storeDef, true);
  }

  // Load built-in data store from storages barrel
  const storages = require('storages');
  await storages.init(config);
  const dataStoreModule = storages.dataStoreModule;
  const localSettings = {
    attachments: { setFileReadToken: true },
    versioning: config.get('versioning')
  };
  newMall.addStore(dataStoreModule, { id: 'local', name: 'Local', settings: localSettings });
  // account (system streams backed by baseStorage account fields)
  const { accountStore } = require('storages/datastores/account/index.ts');
  newMall.addStore(accountStore, { id: 'account', name: 'Account', settings: {} });

  // audit
  if (config.get('audit:active')) {
    const auditDataStore = require('audit/src/datastore/auditDataStore.ts').default;
    newMall.addStore(auditDataStore, { id: '_audit', name: 'Audit', settings: {} });
  }

  // custom stores replacing a built-in one, registered last so they win the id
  for (const storeDef of plan.replacing) {
    logger.info(`Loading store "${storeDef.name}" from ${storeDef.path}: replaces the built-in store "${storeDef.id}"`);
    addCustomStore(storeDef, false);
  }

  await newMall.init();

  return newMall;
}
