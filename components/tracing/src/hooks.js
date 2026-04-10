/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// REF: https://stackabuse.com/using-async-hooks-for-request-context-handling-in-node-js

const asyncHooks = require('async_hooks');
const cuid = require('cuid');
const store = new Map();

const asyncHook = asyncHooks.createHook({
  init: (asyncId, _, triggerAsyncId) => {
    if (store.has(triggerAsyncId)) {
      store.set(asyncId, store.get(triggerAsyncId));
    }
  },
  destroy: (asyncId) => {
    if (store.has(asyncId)) {
      store.delete(asyncId);
    }
  }
});

asyncHook.enable();

const createRequestContext = (data, requestId = cuid()) => {
  const requestInfo = { requestId, data };
  store.set(asyncHooks.executionAsyncId(), requestInfo);
  return requestInfo;
};

const getRequestContext = () => {
  return store.get(asyncHooks.executionAsyncId());
};

module.exports = { createRequestContext, getRequestContext };
