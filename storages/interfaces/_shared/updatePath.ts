/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The update-key grammar shared by every storage engine.
 *
 * Update keys address at most one level inside a JSON field. A bare key
 * (`data`, `clientData`, `name`) names the whole field and `$set` replaces its
 * entire value. A key with exactly one dot, `<field>.<key>`, names one entry of
 * a JSON-object field: `$set` replaces that entry's whole value (an object
 * value is not merged deeper), `$unset` removes the entry, and
 * `$inc`/`$min`/`$max` apply to the entry's numeric value, treating a missing
 * entry as absent (`$inc` starts from 0, `$min`/`$max` store the operand).
 *
 * Everything after the first dot is the LITERAL entry name, so a second dot is
 * not a separator; keys with two or more dots, or with an empty segment
 * (`.x`, `x.`), are rejected with an error on every engine.
 *
 * The object form `{ <field>: { k1: v1, k2: null } }` on a JSON-object field is
 * shorthand for `$set['<field>.k1'] = v1` plus `$unset['<field>.k2']` with
 * `k1`/`k2` taken literally (they may contain dots); it merges one level into
 * the existing object, never deeper, and a missing field counts as `{}` (a
 * `null` sub-value therefore never stores a literal `null`).
 *
 * To change something nested deeper than one level, read the entry, modify it,
 * and `$set` it back, or give it its own entry. A single update must not target
 * the same JSON field with both `$set`/`$unset` and one of `$inc`/`$min`/`$max`.
 *
 * Why one level: these JSON fields are application-chosen key/value maps whose
 * keys may legitimately contain dots (they reach the store through the public
 * profile and clientData surfaces). Treating a second dot as a separator would
 * collide with that, and deep atomic writes are not something any caller needs.
 *
 * Implemented by BaseStoragePG._buildUpdateClauses and
 * BaseStorageSQLite.applyUpdateToItem; conformance suite:
 * baseStorage/conformance/UserStorage.test.js [USUP].
 */

/**
 * Split an update key into the field it addresses and, when present, the single
 * entry inside it. Throws when the key carries more than one level, so an
 * engine can never quietly interpret it its own way.
 */
export function splitUpdatePath (key: string): { field: string; entry: string | null } {
  const firstDot = key.indexOf('.');
  if (firstDot === -1) return { field: key, entry: null };

  const field = key.slice(0, firstDot);
  const entry = key.slice(firstDot + 1);
  if (field.length === 0 || entry.length === 0 || entry.includes('.')) {
    throw new Error(
      `Unsupported update path "${key}": at most one dot is allowed (<field> or <field>.<key>). ` +
      'To write an entry whose name contains a dot, use the object form { <field>: { "<name>": value } }.'
    );
  }
  return { field, entry };
}
