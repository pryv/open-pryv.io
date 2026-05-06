/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Account streams — config-derived queries for account streams.
 * All values pre-computed at init (dataset is ~15 streams — no lazy caching needed).
 */

const treeUtils = require('utils').treeUtils;
const { getConfig } = require('@pryv/boiler');
const IS_SHOWN = 'isShown';
const IS_INDEXED = 'isIndexed';
const IS_UNIQUE = 'isUnique';

const PRYV_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';
const STREAM_ID_ACCOUNT = PRYV_PREFIX + 'account';
const ALL = 'all';

// Module-level state — all set by initializeState()
let initialized = false;
let streamIdWithPrefixToWithout = null;
let accountStreamIdWithoutPrefixToWith = null;

// Live exports — reassigned by initializeState()
let allAsTree: any = null;
let accountChildren: any = null;
let accountMap: any = null;
let accountLeavesMap: any = null;
let hiddenStreamIds: any = null;
let indexedFieldNames: any = null;
let uniqueFieldNames: any = null;

// ── Init ──────────────────────────────────────────────────────────

async function init () {
  if (initialized) { return; }
  const config = await getConfig();
  const settings = config.get('systemStreams');
  if (settings == null) {
    throw Error('Invalid system streams settings');
  }
  initializeState(settings);
  initialized = true;
}

/**
 * Test-only — reloads from a custom config.
 * See "config.default-streams.test.js" (V9QB, 5T5S, ARD9).
 */
async function reloadForTests (config) {
  config = config || (await getConfig());
  if (config.get('NODE_ENV') !== 'test') {
    console.error('this is meant to be used in test only');
    process.exit(1);
  }
  initializeState(config.get('systemStreams'));
  initialized = true;
}

// ── Pre-computed data (all set at init) ───────────────────────────

function initializeState (settings) {
  allAsTree = settings;
  accountChildren = treeUtils.findById(settings, STREAM_ID_ACCOUNT).children;

  // Account stream maps (flat)
  accountMap = filterMapStreams(accountChildren, ALL);
  accountLeavesMap = buildLeavesMap(accountChildren);
  // ID arrays
  const accountStreamIds = Object.keys(accountMap);
  const readableIds = Object.keys(filterMapStreams(accountChildren, IS_SHOWN));
  const readableSet = new Set(readableIds);
  hiddenStreamIds = accountStreamIds.filter(k => !readableSet.has(k));
  indexedFieldNames = Object.keys(filterMapStreams(accountChildren, IS_INDEXED)).map(stripPrefix);
  uniqueFieldNames = Object.keys(filterMapStreams(accountChildren, IS_UNIQUE)).map(stripPrefix);

  // Prefix translation maps
  streamIdWithPrefixToWithout = {};
  accountStreamIdWithoutPrefixToWith = {};
  const allStreamIds = treeUtils.flattenTree(settings).map((s) => s.id);
  for (const prefixed of allStreamIds) {
    const unprefixed = stripPrefix(prefixed);
    streamIdWithPrefixToWithout[prefixed] = unprefixed;
    if (accountMap[prefixed] != null) {
      accountStreamIdWithoutPrefixToWith[unprefixed] = prefixed;
    }
  }
}

function buildLeavesMap (children) {
  const flatList = treeUtils.flattenTreeWithoutParents(children);
  const map = {};
  for (const stream of flatList) {
    map[stream.id] = stream;
  }
  return map;
}

// ── Prefix utilities ──────────────────────────────────────────────

function toFieldName (streamIdWithPrefix) {
  return streamIdWithPrefixToWithout[streamIdWithPrefix] || streamIdWithPrefix;
}

function toStreamId (fieldName) {
  const prefixed = accountStreamIdWithoutPrefixToWith[fieldName];
  if (prefixed == null) {
    throw new Error('trying to call toStreamId() with non-account fieldName: ' + fieldName);
  }
  return prefixed;
}

// ── Internal helpers ──────────────────────────────────────────────

function filterMapStreams (streams, filter = IS_SHOWN) {
  const streamsMap = {};
  if (!Array.isArray(streams)) { return streamsMap; }
  const flatList = treeUtils.flattenTree(streams);
  for (const stream of flatList) {
    if (filter === ALL || stream[filter]) {
      streamsMap[stream.id] = stream;
    }
  }
  return streamsMap;
}

function stripPrefix (streamId) {
  if (streamId.startsWith(PRYV_PREFIX)) { return streamId.substring(PRYV_PREFIX.length); }
  if (streamId.startsWith(CUSTOMER_PREFIX)) { return streamId.substring(CUSTOMER_PREFIX.length); }
  throw new Error('accountStreams initialization: stripPrefix(streamId) should be called with a prefixed streamId');
}

// ── Exports ───────────────────────────────────────────────────────

export {
  // Constants
  STREAM_ID_ACCOUNT,
  // Lifecycle
  init,
  reloadForTests,
  // Data properties (live `let` bindings — null before init, populated by initializeState)
  allAsTree,
  accountChildren,
  accountMap,
  accountLeavesMap,
  hiddenStreamIds,
  indexedFieldNames,
  uniqueFieldNames,
  // Prefix utilities
  toFieldName,
  toStreamId
};

/**
 * @typedef {Stream & {
 *   isIndexed: boolean;
 *   isUnique: boolean;
 *   isShown: boolean;
 *   isEditable: boolean;
 *   isRequiredInValidation: boolean;
 * }} SystemStream
 */
