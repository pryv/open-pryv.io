/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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

/**
 * Patch a Database instance and to add tracing functions
 */

const { getHookedTracer } = require('./HookedTracer');
const { getConfigUnsafe } = require('@pryv/boiler');
const isTracingEnabled = getConfigUnsafe(true).get('trace:enable');

module.exports = function patch (db) {
  if (!isTracingEnabled) return;
  const functionsToPatch = getAllFuncs(db);
  for (const fInfo of functionsToPatch) {
    if (fInfo.id === 'getCollection' || fInfo.id === 'getCollectionSafe') continue; // ignores

    if (fInfo.params[0] === 'collectionInfo' && fInfo.params.includes('callback')) {
      const callbackIndex = fInfo.params.findIndex(e => e === 'callback');
      db[fInfo.id + '_'] = db[fInfo.id];

      // replace original function
      db[fInfo.id] = function () {
        const tracer = getHookedTracer('db:' + fInfo.id + ':' + arguments[0].name);
        arguments[callbackIndex] = tracer.finishOnCallBack(arguments[callbackIndex]);
        db[fInfo.id + '_'](...arguments);
      };
    }
  }
};

function getAllFuncs (toCheck) {
  const props = [];
  let obj = toCheck;
  do {
    props.push(...Object.getOwnPropertyNames(obj));
  } while ((obj = Object.getPrototypeOf(obj)) != null);
  return props.sort().map((e, i, arr) => {
    if (e !== arr[i + 1] && typeof toCheck[e] === 'function') {
      const params = getParamNames(toCheck[e]);
      return { id: e, params };
    }
    return null;
  }).filter(f => f != null);
}

const STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;
const ARGUMENT_NAMES = /([^\s,]+)/g;
function getParamNames (func) {
  const fnStr = func.toString().replace(STRIP_COMMENTS, '');
  let result = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
  if (result === null) { result = []; }
  return result;
}
