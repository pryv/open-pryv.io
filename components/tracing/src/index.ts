/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Tracing component — currently a no-op shim. See Tracing.js for the rationale.
// The exported API surface (DummyTracing, dataBaseTracer, getHookerTracer,
// initRootSpan, tracingMiddleware) is preserved so a future tracer can replace
// the implementations without touching consumers.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { DummyTracing } = require('./Tracing');
const { getHookedTracer } = require('./HookedTracer');
const { databaseTracer: dataBaseTracer } = require('./databaseTracer');

const getHookerTracer = getHookedTracer;

function initRootSpan () {
  return new DummyTracing();
}

function tracingMiddleware (name = 'express1') {
  return function (req, res, next) {
    if (req.tracing == null) {
      req.tracing = initRootSpan();
    }
    next();
  };
}

export { DummyTracing, dataBaseTracer, getHookerTracer, initRootSpan, tracingMiddleware };
