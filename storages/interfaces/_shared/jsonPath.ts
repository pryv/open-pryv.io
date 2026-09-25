/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared contract of `UserStorage.compareAndSetJson`: one conditional update
 * of JSON values inside a stored item, atomic per row on every engine.
 *
 * Paths start at the item root, e.g. `['data', 'mfa', 'totp', 'lastUsedStep']`:
 * `path[0]` is the item field holding a JSON document (`data` on the profile
 * collection), the rest walks into it.
 */

/**
 * One guard, exactly one of:
 *  - `eq`: the stored value equals (strings and integers, compared as text);
 *  - `lt`: the stored value is a number strictly below (absent or not a number FAILS);
 *  - `absent: true`: nothing is stored at the path (a JSON null counts as absent).
 */
export type JsonGuard = { path: string[]; eq?: string | number; lt?: number; absent?: true };

/**
 * One write. `value` is any JSON value. The parent of the path must already be
 * an object, else the call writes nothing and answers false (it acts as an
 * implicit guard): write a whole sub-object when its parent may be missing.
 */
export type JsonSet = { path: string[]; value: unknown };

// Segments reach SQL text as JSON path literals on some engines, so they are
// restricted to a charset that needs no quoting.
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function assertJsonPath (path: string[]): void {
  if (!Array.isArray(path) || path.length < 2 || path.length > 6) {
    throw new Error(`compareAndSetJson: a path needs 2 to 6 segments, got ${JSON.stringify(path)}`);
  }
  for (const s of path) {
    if (typeof s !== 'string' || !SEGMENT.test(s)) {
      throw new Error(`compareAndSetJson: invalid path segment ${JSON.stringify(s)}`);
    }
  }
}

export function assertCompareAndSet (guards: JsonGuard[], sets: JsonSet[]): void {
  if (!Array.isArray(guards) || guards.length === 0) throw new Error('compareAndSetJson: at least one guard is required');
  if (!Array.isArray(sets) || sets.length === 0) throw new Error('compareAndSetJson: at least one set is required');
  for (const g of guards) {
    assertJsonPath(g.path);
    const kinds = [g.eq !== undefined, g.lt !== undefined, g.absent === true].filter(Boolean).length;
    if (kinds !== 1) throw new Error('compareAndSetJson: a guard needs exactly one of eq, lt, absent');
    if (g.eq !== undefined && typeof g.eq !== 'string' && !Number.isInteger(g.eq)) {
      throw new Error('compareAndSetJson: eq must be a string or an integer');
    }
    if (g.lt !== undefined && !Number.isFinite(g.lt)) throw new Error('compareAndSetJson: lt must be a finite number');
  }
  for (const s of sets) {
    assertJsonPath(s.path);
    if (s.value === undefined) throw new Error('compareAndSetJson: a set needs a value');
  }
}
