/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const { ALL_EVENTS_TAG } = require('./schema/events');

module.exports = {
  toSQLiteQuery
};

/**
 * Get stream queries for SQLite - to be run on
 * @param {Object[]} streamQuery
 */
function toSQLiteQuery (streamQuery) {
  if (streamQuery == null) return null;

  if (streamQuery.length === 1) {
    return processAndBlock(streamQuery[0]);
  } else { // pack in $or
    return '(' + streamQuery.map(processAndBlock).join(') OR (') + ')';
  }

  function processAndBlock (andBlock) {
    if (typeof andBlock === 'string') return '"' + andBlock + '"';

    const anys = [];
    const nots = [];
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

function addQuotes (array) {
  return array.map((x) => '"' + x + '"');
}
