/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Helper for handling query string parameter values.
 */

function isReservedId (s: string) {
  switch (s) {
    case 'null':
    case 'undefined':
    case '*':
      return true;
    default:
      return false;
  }
}

/**
 * Whether a client-chosen access token is refused: the reserved ids, plus the
 * names of built-in object properties (`__proto__`, `constructor`,
 * `toString`, ...) and `prototype`, which must never become lookup keys.
 */
function isReservedToken (s: string) {
  return isReservedId(s) || s === 'prototype' || Object.prototype.hasOwnProperty.call(Object.prototype, s);
}

function sanitizeFieldKey (s: string) {
  return (s[0] === '$' ? '_' + s.substr(1) : s).replace('.', ':');
}

export { isReservedId, isReservedToken, sanitizeFieldKey };
