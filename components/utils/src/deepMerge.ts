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
 * Prototype safe: an own `__proto__` key (which `JSON.parse` creates) is
 * skipped, and the merge only recurses into the target's OWN properties, so
 * no source can write into `Object.prototype` or a class prototype.
 *
 * @template T
 */
function deepMerge (target: Record<string, unknown> | null | undefined, ...sources: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  if (target == null) target = {};
  for (const source of sources) {
    if (source == null) continue;
    for (const key of Object.keys(source)) {
      if (key === '__proto__') continue;
      const sv = source[key];
      // lodash _.merge skips undefined source values when the destination
      // already has a value. Match that behaviour so callers that pass
      // `{ password: undefined }` to override-or-keep don't accidentally
      // wipe the existing value.
      if (sv === undefined) continue;
      const tv = Object.hasOwn(target, key) ? target[key] : undefined;
      if (isPlainObject(sv) && isPlainObject(tv)) {
        deepMerge(tv, sv);
      } else {
        target[key] = sv;
      }
    }
  }
  return target;
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  if (v === Object.prototype) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export { deepMerge };
