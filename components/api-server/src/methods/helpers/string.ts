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

function isReservedId (s: any) {
  switch (s) {
    case 'null':
    case 'undefined':
    case '*':
      return true;
    default:
      return false;
  }
}

function sanitizeFieldKey (s: any) {
  return (s[0] === '$' ? '_' + s.substr(1) : s).replace('.', ':');
}

export { isReservedId, sanitizeFieldKey };
