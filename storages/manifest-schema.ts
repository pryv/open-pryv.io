/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

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

type EngineManifest = {
  storageTypes: string[];
  entrypoint: string;
  requiredInternals?: string[];
  scripts?: Record<string, string>;
  [k: string]: unknown;
};

/**
 * @param manifest - Parsed manifest.json object
 * @param engineDir - Path to the engine directory (for error messages)
 * @throws {Error} If validation fails
 */
function validateManifest (manifest: unknown, engineDir: string): EngineManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid manifest in ${engineDir}: must be a non-null object`);
  }
  const m = manifest as Record<string, unknown>;

  // storageTypes: required non-empty array of valid types
  if (!Array.isArray(m.storageTypes) || m.storageTypes.length === 0) {
    throw new Error(`Invalid manifest in ${engineDir}: "storageTypes" must be a non-empty array`);
  }
  for (const st of m.storageTypes) {
    if (typeof st !== 'string' || !VALID_STORAGE_TYPES.includes(st)) {
      throw new Error(`Invalid manifest in ${engineDir}: unknown storageType "${st}". Valid: ${VALID_STORAGE_TYPES.join(', ')}`);
    }
  }

  // entrypoint: required string
  if (typeof m.entrypoint !== 'string' || !m.entrypoint) {
    throw new Error(`Invalid manifest in ${engineDir}: "entrypoint" must be a non-empty string`);
  }

  // requiredInternals: optional array of strings
  if (m.requiredInternals != null) {
    if (!Array.isArray(m.requiredInternals)) {
      throw new Error(`Invalid manifest in ${engineDir}: "requiredInternals" must be an array if present`);
    }
    for (const ri of m.requiredInternals) {
      if (typeof ri !== 'string') {
        throw new Error(`Invalid manifest in ${engineDir}: each requiredInternals entry must be a string`);
      }
    }
  }

  // scripts: optional object with string values
  if (m.scripts != null) {
    if (typeof m.scripts !== 'object') {
      throw new Error(`Invalid manifest in ${engineDir}: "scripts" must be an object if present`);
    }
  }

  return m as unknown as EngineManifest;
}

export { validateManifest, VALID_STORAGE_TYPES };