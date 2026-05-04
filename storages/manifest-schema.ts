/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Validates a storage engine manifest.json against the expected schema.
 *
 * manifest.json only contains storage–service-core integration fields.
 * Standard package metadata (name, version, description) belongs in package.json.
 *
 * Required fields:
 *   storageTypes  — array of supported storage types
 *   entrypoint    — path to the JS module exporting factory functions
 *
 * Optional fields:
 *   requiredInternals — host capabilities the engine needs at init
 *   scripts           — setup/start scripts paths
 */

const VALID_STORAGE_TYPES = ['baseStorage', 'dataStore', 'platformStorage', 'seriesStorage', 'fileStorage', 'auditStorage'];

/**
 * @param {Object} manifest - Parsed manifest.json object
 * @param {string} engineDir - Path to the engine directory (for error messages)
 * @returns {Object} The validated manifest
 * @throws {Error} If validation fails
 */
function validateManifest (manifest, engineDir) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid manifest in ${engineDir}: must be a non-null object`);
  }

  // storageTypes: required non-empty array of valid types
  if (!Array.isArray(manifest.storageTypes) || manifest.storageTypes.length === 0) {
    throw new Error(`Invalid manifest in ${engineDir}: "storageTypes" must be a non-empty array`);
  }
  for (const st of manifest.storageTypes) {
    if (!VALID_STORAGE_TYPES.includes(st)) {
      throw new Error(`Invalid manifest in ${engineDir}: unknown storageType "${st}". Valid: ${VALID_STORAGE_TYPES.join(', ')}`);
    }
  }

  // entrypoint: required string
  if (typeof manifest.entrypoint !== 'string' || !manifest.entrypoint) {
    throw new Error(`Invalid manifest in ${engineDir}: "entrypoint" must be a non-empty string`);
  }

  // requiredInternals: optional array of strings
  if (manifest.requiredInternals != null) {
    if (!Array.isArray(manifest.requiredInternals)) {
      throw new Error(`Invalid manifest in ${engineDir}: "requiredInternals" must be an array if present`);
    }
    for (const ri of manifest.requiredInternals) {
      if (typeof ri !== 'string') {
        throw new Error(`Invalid manifest in ${engineDir}: each requiredInternals entry must be a string`);
      }
    }
  }

  // scripts: optional object with string values
  if (manifest.scripts != null) {
    if (typeof manifest.scripts !== 'object') {
      throw new Error(`Invalid manifest in ${engineDir}: "scripts" must be an object if present`);
    }
  }

  return manifest;
}

module.exports = { validateManifest, VALID_STORAGE_TYPES };
