/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const config = require('@pryv/boiler').getConfigUnsafe(true);
const logger = require('@pryv/boiler').getLogger('integrity');
const stableRepresentation = require('@pryv/stable-object-representation');
const { integrityAlgorithmProblem } = require('./algorithms.ts') as typeof import('./algorithms.ts');
const { composeWireAccess } = require('../accesses/refs.ts') as typeof import('../accesses/refs.ts');

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
 * (sha1 and md5 kept to serve checksums stored with them; see ./algorithms.ts
 * for the algorithms accepted for new ones)
 */
type EventLike = { integrity?: string; [k: string]: unknown };
type AccessLike = { integrity?: string; [k: string]: unknown };
type IntegrityResult = { integrity: string; key: string };

const subResourceCodeToDigestMap: Record<string, string> = {
  sha256: 'SHA-256',
  sha512: 'SHA-512',
  sha1: 'SHA',
  md5: 'MD5'
};

/**
 * @param subResourceIntegrity in the form of `<algo>-<hash>` example `sha256-uZKmWZ+CQ7UY3GUqFWD4sNPPEUKm8OPcAWr4780Acnk=`
 */
function getHTTPDigestHeaderForAttachment (subResourceIntegrity: string): string | null {
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
const attachments = {
  isActive: attachmentsIsActive,
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

// ------------- events ------------------ //

// The library's compute() hashes with its default algorithm whatever it is
// given: build the pair here so it always uses the configured one.
function computeEvent (event: EventLike): IntegrityResult {
  return { key: keyEvent(event), integrity: hashEvent(event) };
}

function keyEvent (event: EventLike): string {
  return stableRepresentation.event.key(event);
}

function hashEvent (event: EventLike): string {
  return stableRepresentation.event.hash(event, algorithm);
}

function setOnEvent (event: EventLike): EventLike | undefined {
  delete event.integrity;
  if (!eventsIsActive) return;
  event.integrity = hashEvent(event);
  return event;
}

const events = {
  isActive: eventsIsActive,
  compute: computeEvent,
  key: keyEvent,
  hash: hashEvent,
  set: setOnEvent
};

// ------------- accesses ------------------ //

// The hashed form of an access is the object its owner receives: composite
// `id` / `createdBy` / `modifiedBy`, no `serial`, `*BySerial` nor `headId`
// (a history row hashes under its `<base>[:<serial>]` id), and no `usage`
// (derived at read time, like `lastUsed` and `calls`). Idempotent on an object
// already in that form, so a storage row and the API response hash alike.
function canonicalAccess (access: AccessLike): AccessLike {
  if (access == null) return access;
  const out: AccessLike = (typeof access.id === 'string' && access.id.length > 0)
    ? composeWireAccess(access as Parameters<typeof composeWireAccess>[0],
      typeof access.headId === 'string' ? access.headId : undefined)
    : Object.assign({}, access);
  delete out.usage;
  return out;
}

function computeAccess (access: AccessLike): IntegrityResult {
  return { key: keyAccess(access), integrity: hashAccess(access) };
}

function keyAccess (access: AccessLike): string {
  return stableRepresentation.access.key(canonicalAccess(access));
}

function hashAccess (access: AccessLike): string {
  return stableRepresentation.access.hash(canonicalAccess(access), algorithm);
}

// The hash of the stored row itself, as versions before the canonical form
// computed it: only for the one-time recompute of stored hashes at upgrade,
// which rewrites a row only when its stored value is this one.
function rowFormHashAccess (access: AccessLike): string {
  return stableRepresentation.access.hash(access, algorithm);
}

function setOnAccess (access: AccessLike): AccessLike | undefined {
  if (!accessesIsActive) return;
  access.integrity = hashAccess(access);
  return access;
}

const accesses = {
  isActive: accessesIsActive,
  compute: computeAccess,
  key: keyAccess,
  hash: hashAccess,
  rowFormHash: rowFormHashAccess,
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

// config check (also run by the boot config validation and bin/check-config.js):
// output message and crash if the checksum algorithm is not accepted

const algorithmProblem = integrityAlgorithmProblem(algorithm);
if (algorithmProblem != null) {
  logger.error(algorithmProblem);
  console.log('Error: ' + algorithmProblem);
  process.exit(1);
}

export default integrity;
export { integrity };
