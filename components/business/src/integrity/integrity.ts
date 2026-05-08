/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getConfigUnsafe, getLogger } = require('@pryv/boiler');
const logger = getLogger('integrity');
const stableRepresentation = require('@pryv/stable-object-representation');

// --------------- CONFIGURATION -------------- //
// Lazy-initialised on first integrity API use so the read happens
// post-boiler-init (no need for the legacy `getConfigUnsafe(true)`
// warnOnly escape hatch).
let _initialized = false;
let _eventsIsActive = false;
let _accessesIsActive = false;
let _attachmentsIsActive = false;
let _algorithm: string | undefined;
function _init () {
  if (_initialized) return;
  let config;
  try {
    config = getConfigUnsafe();
  } catch (err) {
    // Config not yet ready (test-helpers/src/data/events.ts pre-computes
    // integrity hashes at module-load time, before mocha's first
    // `before()` awaits getConfig). Bail without memoizing — flags stay
    // default-false so events.set() no-ops, matching the legacy
    // getConfigUnsafe(true) warnOnly behavior. Next call after init
    // resolves will succeed and memoize.
    return;
  }
  _initialized = true;
  const configIntegrity = config.get('integrity');
  _eventsIsActive = configIntegrity?.isActive?.events || false;
  _accessesIsActive = configIntegrity?.isActive?.accesses || false;
  _attachmentsIsActive = configIntegrity?.isActive?.attachments || false;
  _algorithm = config.get('integrity:algorithm');
  // crash early on unsupported algorithm if any integrity surface is active
  if ((_eventsIsActive || _attachmentsIsActive) && (subResourceCodeToDigestMap[_algorithm as string] == null)) {
    const message = 'Integrity is active and algorithm [' + _algorithm + '] is unsupported. Choose one of: ' + Object.keys(subResourceCodeToDigestMap).join(', ');
    logger.error(message);
    console.log('Error: ' + message);
    process.exit(1);
  }
}
function getEventsIsActive (): boolean { _init(); return _eventsIsActive; }
function getAccessesIsActive (): boolean { _init(); return _accessesIsActive; }
function getAttachmentsIsActive (): boolean { _init(); return _attachmentsIsActive; }
function getAlgorithm (): string { _init(); return _algorithm as string; }

// --------------- ATTACHMENTS ---------------- //

/**
 * @private
 * mapping algo codes to https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Digest supported codes
 */
const subResourceCodeToDigestMap = {
  sha256: 'SHA-256',
  sha512: 'SHA-512',
  sha1: 'SHA',
  md5: 'MD5'
};

/**
 * @param subResourceIntegrity in the form of `<algo>-<hash>` example `sha256-uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk=`
 */
function getHTTPDigestHeaderForAttachment (subResourceIntegrity) {
  const splitAt = subResourceIntegrity.indexOf('-');
  const algo = subResourceIntegrity.substr(0, splitAt);
  const sum = subResourceIntegrity.substr(splitAt + 1);
  const digestAlgo = subResourceCodeToDigestMap[algo];
  if (digestAlgo == null) return null;
  return digestAlgo + '=' + sum;
}

// Integrity access and computation for attachments
// IntegrityMulterDiskStorage, IntegrityCompute, IntegritySet,
// IntegrityHash were JSDoc-only references that have no real TS declaration.
type IntegrityAttachments = {
  isActive: boolean; // Setting: Add integrity hash to attachment if true
  MulterIntegrityDiskStorage: any;
};
const attachments = {
  get isActive (): boolean { return getAttachmentsIsActive(); },
  getHTTPDigestHeaderForAttachment,
  MulterIntegrityDiskStorage: require('./MulterIntegrityDiskStorage.ts').default
};

// ----------------- standard db Items -------------- //

/**
 * @property {string} integrity - and integrity code for an item. Exemple 'EVENT:0:sha256-uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk='
 * @property {string} key - and unique key for this object. Exemple 'EVENT:0:<id>:<modified>'
 */

/**
 * Returns integrity and key of an object
 * @param item - Object to compute on
 * @param save - This computation should be saved for audit
 */

/**
 * Compute and set integrity property to an item
 * @param item - Object to compute on
 * @param save - This computation should be saved for audit
 */

/**
 * Get the hash (only .integrity) of an item item
 * @param item - Object to compute on
 * @param save - This computation should be saved for audit
 */

// Setting and computation tools for a Pryv.io db item
type IntegrityItem = {
  isActive: boolean; // Setting: Add integrity hash to item if true
  compute: any; // was IntegrityCompute (JSDoc-only)
  set: any; // was IntegritySet (JSDoc-only)
  hash: any; // was IntegrityHash (JSDoc-only)
};
// ------------- events ------------------ //

function computeEvent (event) {
  return stableRepresentation.event.compute(event, getAlgorithm());
}

function keyEvent (event) {
  return stableRepresentation.event.key(event);
}

function hashEvent (event) {
  return stableRepresentation.event.hash(event, getAlgorithm());
}

function setOnEvent (event) {
  delete event.integrity;
  if (!getEventsIsActive()) return;
  event.integrity = hashEvent(event);
  return event;
}

const events = {
  get isActive (): boolean { return getEventsIsActive(); },
  compute: computeEvent,
  key: keyEvent,
  hash: hashEvent,
  set: setOnEvent
};

// ------------- accesses ------------------ //

function computeAccess (access) {
  return stableRepresentation.access.compute(access, getAlgorithm());
}

function keyAccess (access) {
  return stableRepresentation.access.key(access);
}

function hashAccess (access) {
  return stableRepresentation.access.hash(access, getAlgorithm());
}

function setOnAccess (access) {
  if (!getAccessesIsActive()) return;
  access.integrity = hashAccess(access);
  return access;
}

const accesses = {
  get isActive (): boolean { return getAccessesIsActive(); },
  compute: computeAccess,
  key: keyAccess,
  hash: hashAccess,
  set: setOnAccess
};

// ------- Exports ---------- //

/**
 * Integrity tools
 * @property {IntegrityItem} events - computation and settings for events integrity
 * @property {IntegrityAttachments} attachments - computation and settings for events integrity
 * @property {string} algorythm - Setting : algorithm keyCode to use for hash computation
 */
const integrity = {
  events,
  accesses,
  attachments,
  get algorithm (): string { return getAlgorithm(); }
};

export default integrity;
export { integrity };