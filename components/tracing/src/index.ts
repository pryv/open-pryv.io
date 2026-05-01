/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

// Tracing component — currently a no-op shim. See Tracing.js for the rationale.
// The exported API surface (DummyTracing, dataBaseTracer, getHookerTracer,
// initRootSpan, tracingMiddleware) is preserved so a future tracer can replace
// the implementations without touching consumers.

const { DummyTracing } = require('./Tracing');
const { getHookedTracer } = require('./HookedTracer');
const dataBaseTracer = require('./databaseTracer');

module.exports.DummyTracing = DummyTracing;
module.exports.dataBaseTracer = dataBaseTracer;
module.exports.getHookerTracer = getHookedTracer;

function initRootSpan () {
  return new DummyTracing();
}
module.exports.initRootSpan = initRootSpan;

module.exports.tracingMiddleware = (name = 'express1') => {
  return function (req, res, next) {
    if (req.tracing == null) {
      req.tracing = initRootSpan();
    }
    next();
  };
};
