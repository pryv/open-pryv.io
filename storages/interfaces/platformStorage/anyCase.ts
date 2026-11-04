/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/** The characters an engine trims from a stored value before matching it (SQL `trim(x, chars)`). */
export const TRIMMED_CHARS = ' \t\n\r\f\v';

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
