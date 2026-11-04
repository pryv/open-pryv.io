/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The characters an engine trims from a stored value before matching it (SQL
 * `trim(x, chars)` / `btrim`): those JavaScript's `trim()` removes (white
 * space and line terminators), so that a stored value matches as
 * `PiiHasher.normalize` compares it.
 */
export const TRIMMED_CHARS = String.fromCharCode(
  0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
);

/**
 * The SQL `LIKE` pattern (escape character `\`) that `getUsersUniqueFieldAnyCase`
 * matches a stored unique value against, the stored value trimmed: `value`
 * trimmed, its ASCII characters as themselves (a case-insensitive `LIKE`
 * compares their letters in any case: SQLite's `LIKE`, PostgreSQL's `ILIKE`),
 * every other character as `_` (any one character: an engine compares the
 * case of ASCII letters only, or by its locale). The rows matched are a
 * superset of those holding `value` in another case: the caller compares.
 */
export function anyCaseLikePattern (value: string): string {
  let pattern = '';
  for (const char of value.trim()) {
    if (char === '%' || char === '_' || char === '\\') pattern += '\\' + char;
    else if (char.charCodeAt(0) > 0x7f) pattern += '_';
    else pattern += char;
  }
  return pattern;
}

/**
 * True when a stored value matches `value` as `getUsersUniqueFieldAnyCase`
 * selects it on the rqlite engine (SQLite's case-insensitive `LIKE` over
 * `anyCaseLikePattern(value)`, the stored value trimmed): the same length in
 * characters, an ASCII character of `value` equal in any case, any one
 * character where `value` has one outside ASCII. For a caller that selects
 * among rows it read itself, with the same result as the engine's query.
 */
export function anyCaseLikeMatches (storedValue: string, value: string): boolean {
  const stored = [...storedValue.trim()];
  const wanted = [...value.trim()];
  if (stored.length !== wanted.length) return false;
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i].charCodeAt(0) > 0x7f) continue;
    if (stored[i].charCodeAt(0) > 0x7f) return false;
    if (wanted[i].toLowerCase() !== stored[i].toLowerCase()) return false;
  }
  return true;
}
