/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const { ALL_EVENTS_TAG } = require('./schema/events');

module.exports = {
  toSQLiteQuery
};

/**
 * Get stream queries for SQLite.
 */
function toSQLiteQuery (streamQuery: any): string | null {
  if (streamQuery == null) return null;

  if (streamQuery.length === 1) {
    return processAndBlock(streamQuery[0]);
  } else { // pack in $or
    return '(' + streamQuery.map(processAndBlock).join(') OR (') + ')';
  }

  function processAndBlock (andBlock: any): string | null {
    if (typeof andBlock === 'string') return '"' + andBlock + '"';

    const anys: string[] = [];
    const nots: string[] = [];
    for (const andItem of andBlock) {
      if (andItem.any != null && andItem.any.length > 0) {
        if (andItem.any.indexOf('*') > -1) continue; // skip and with '*';
        if (andItem.any.length === 1) {
          anys.push(addQuotes(andItem.any)[0]);
        } else {
          anys.push('(' + addQuotes(andItem.any).join(' OR ') + ')');
        }
      } else if (andItem.not != null && andItem.not.length > 0) {
        nots.push(' NOT ' + addQuotes(andItem.not).join(' NOT '));
      } else {
        throw new Error('Go a query block with no any or not item ' + andBlock);
      }
    }

    if (anys.length === 0) {
      anys.push('"' + ALL_EVENTS_TAG + '"');
    }

    const res = anys.join(' AND ') + nots.join('');
    if (res === ALL_EVENTS_TAG) return null;
    return res;
  }
}

function addQuotes (array: string[]): string[] {
  return array.map((x) => '"' + x + '"');
}
