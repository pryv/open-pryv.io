/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Sanitize exported documents by stripping engine-specific internal fields
 * and normalizing identifiers to a canonical engine-agnostic format.
 *
 * MongoDB exportAll() returns raw docs with `_id`, `userId`, `__v`, `streamId`, `profileId`.
 * PostgreSQL exportAll() returns clean data with `id`.
 * SQLite exportAll() returns raw rows.
 *
 * This module normalizes all engine outputs so the backup format is
 * engine-agnostic. Each engine's `importAll` is responsible for
 * converting back to its own format.
 */

// Type-only import to mark this as a TS module (not a script). Erased at
// strip-time by Node 24 and not emitted as ESM, so `module.exports` below
// keeps working as CJS at runtime.
/**
 * Fields that are engine-internal and must be stripped from backup output.
 * These are storage-layer artifacts, not part of the application model.
 */
const INTERNAL_FIELDS: string[] = [
  '_id', // MongoDB ObjectId
  '__v', // MongoDB version key
  'userId', // MongoDB user scoping field
  'user_id' // PostgreSQL/SQLite user scoping field
];

/**
 * Engine-specific identifier fields that must be renamed to the canonical `id`.
 * MongoDB uses `streamId` for streams and `profileId` for profile entries,
 * but the engine-agnostic backup format uses `id` for all entity types.
 */
const ID_RENAMES: Record<string, string> = { streamId: 'id', profileId: 'id' };

/**
 * Strip internal fields and normalize identifiers.
 * Returns a new object — does not mutate the original.
 *
 * Rules:
 * 1. Engine-specific ID fields (`streamId`, `profileId`) are renamed to `id`.
 * 2. If the document has `_id` but no `id` and no engine-specific ID field,
 *    `_id` is promoted to `id` (events, accesses in MongoDB).
 * 3. Internal fields (`_id`, `__v`, `userId`, `user_id`) are stripped.
 */
function sanitize (doc: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (doc == null) return doc;
  const clean: Record<string, unknown> = {};

  // Check if doc has an engine-specific ID field that should become `id`
  const renamedId = Object.keys(ID_RENAMES).find(f => doc[f] != null);

  // Promote _id to id only if no existing id and no engine-specific ID
  if (doc._id != null && doc.id == null && !renamedId) {
    const rawId = doc._id;
    clean.id = typeof rawId === 'object' && rawId.toString
      ? rawId.toString()
      : rawId;
  }

  for (const key of Object.keys(doc)) {
    if (INTERNAL_FIELDS.includes(key)) continue;
    if (ID_RENAMES[key]) {
      clean[ID_RENAMES[key]] = doc[key];
      continue;
    }
    clean[key] = doc[key];
  }
  return clean;
}

export { sanitize, INTERNAL_FIELDS };