/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
