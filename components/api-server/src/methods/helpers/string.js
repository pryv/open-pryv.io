/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Helper for handling query string parameter values.
 */

const string = module.exports;

string.isReservedId = function (s) {
  switch (s) {
    case 'null':
    case 'undefined':
    case '*':
      return true;
    default:
      return false;
  }
};

string.sanitizeFieldKey = function (s) {
  return (s[0] === '$' ? '_' + s.substr(1) : s).replace('.', ':');
};
