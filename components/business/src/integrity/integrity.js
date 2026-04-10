/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const config = require('@pryv/boiler').getConfigUnsafe(true);
const logger = require('@pryv/boiler').getLogger('integrity');
const stableRepresentation = require('@pryv/stable-object-representation');

// --------------- CONFIGURATION -------------- //
const configIntegrity = config.get('integrity');
const eventsIsActive = configIntegrity?.isActive?.events || false;
const accessesIsActive = configIntegrity?.isActive?.accesses || false;
const attachmentsIsActive = configIntegrity?.isActive?.attachments || false;
const algorithm = config.get('integrity:algorithm');

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
 * @param {string} subResourceIntegrity in the form of `<algo>-<hash>` example `sha256-uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk=`
 * @returns {string} An HTTP Digest header value in the form of `<algo>=<hash>` example `SHA-256=uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk=`
 */
function getHTTPDigestHeaderForAttachment (subResourceIntegrity) {
  const splitAt = subResourceIntegrity.indexOf('-');
  const algo = subResourceIntegrity.substr(0, splitAt);
  const sum = subResourceIntegrity.substr(splitAt + 1);
  const digestAlgo = subResourceCodeToDigestMap[algo];
  if (digestAlgo == null) return null;
  return digestAlgo + '=' + sum;
}

/**
 * Integrity access and computation for attachments
 * @typedef {Object} IntegrityAttachments
 * @property {boolean} isActive - Setting: Add integrity hash to attachment if true
 * @property {IntegrityMulterDiskStorage} MulterIntegrityDiskStorage
 */
const attachments = {
  isActive: attachmentsIsActive,
  getHTTPDigestHeaderForAttachment,
  MulterIntegrityDiskStorage: require('./MulterIntegrityDiskStorage')
};

// ----------------- standard db Items -------------- //

/**
 * @callback IntegrityComputeResult
 * @property {string} integrity - and integrity code for an item. Exemple 'EVENT:0:sha256-uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk='
 * @property {string} key - and unique key for this object. Exemple 'EVENT:0:<id>:<modified>'
 */

/**
 * Returns integrity and key of an object
 * @callback IntegrityCompute
 * @param {*} item - Object to compute on
 * @param {boolean} save - This computation should be saved for audit
 * @returns {IntegrityComputeResult}
 */

/**
 * Compute and set integrity property to an item
 * @callback IntegritySet
 * @param {*} item - Object to compute on
 * @param {boolean} save - This computation should be saved for audit
 * @returns {*} - the item
 */

/**
 * Get the hash (only .integrity) of an item item
 * @callback IntegrityHash
 * @param {*} item - Object to compute on
 * @param {boolean} save - This computation should be saved for audit
 * @returns {*} - the item
 */

/**
 * Setting and computation tools for a Pryv.io db item
 * @typedef {Object} IntegrityItem
 * @property {boolean} isActive - Setting: Add integrity hash to item if true
 * @property {IntegrityCompute} compute
 * @property {IntegritySet} set
 * @property {IntegrityHash} hash
 */

// ------------- events ------------------ //

function computeEvent (event) {
  return stableRepresentation.event.compute(event, algorithm);
}

function keyEvent (event) {
  return stableRepresentation.event.key(event);
}

function hashEvent (event) {
  return stableRepresentation.event.hash(event, algorithm);
}

function setOnEvent (event) {
  delete event.integrity;
  if (!eventsIsActive) return;
  event.integrity = hashEvent(event);
  return event;
}

/**
 * @type {IntegrityItem}
 */
const events = {
  isActive: eventsIsActive,
  compute: computeEvent,
  key: keyEvent,
  hash: hashEvent,
  set: setOnEvent
};

// ------------- accesses ------------------ //

function computeAccess (access) {
  return stableRepresentation.access.compute(access, algorithm);
}

function keyAccess (access) {
  return stableRepresentation.access.key(access);
}

function hashAccess (access) {
  return stableRepresentation.access.hash(access, algorithm);
}

function setOnAccess (access) {
  if (!accessesIsActive) return;
  access.integrity = hashAccess(access);
  return access;
}

/**
 * @type {IntegrityItem}
 */
const accesses = {
  isActive: accessesIsActive,
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
  algorithm
};

// config check
// output message and crash if algorythm is not supported

if ((events.isActive || attachments.isActive) && (subResourceCodeToDigestMap[algorithm] == null)) {
  const message = 'Integrity is active and algorithm [' + algorithm + '] is unsupported. Choose one of: ' + Object.keys(subResourceCodeToDigestMap).join(', ');
  logger.error(message);
  console.log('Error: ' + message);
  process.exit(1);
}

module.exports = integrity;
