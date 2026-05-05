/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Recursively merge source objects into target, mutating target in place.
 * Mirrors lodash's `_.merge` semantics for the call patterns used in this
 * codebase: plain-object values are merged recursively; arrays, primitives
 * and class instances replace the target value.
 *
 * Drop-in replacement for `_.merge(target, ...sources)`. Returns target.
 *
 * @template T
 * @param {T} target
 * @param  {...any} sources
 * @returns {T}
 */
function deepMerge (target, ...sources) {
  if (target == null) target = {};
  for (const source of sources) {
    if (source == null) continue;
    for (const key of Object.keys(source)) {
      const sv = source[key];
      // lodash _.merge skips undefined source values when the destination
      // already has a value. Match that behaviour so callers that pass
      // `{ password: undefined }` to override-or-keep don't accidentally
      // wipe the existing value.
      if (sv === undefined) continue;
      const tv = target[key];
      if (isPlainObject(sv) && isPlainObject(tv)) {
        deepMerge(tv, sv);
      } else {
        target[key] = sv;
      }
    }
  }
  return target;
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export { deepMerge };
