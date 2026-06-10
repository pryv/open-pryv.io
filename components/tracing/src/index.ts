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
import type { Request, Response, NextFunction } from 'express';
import type { DummyTracing as DummyTracingT } from './Tracing.ts';
const require = createRequire(import.meta.url);

const { DummyTracing } = require('./Tracing.ts');
const { getHookedTracer } = require('./HookedTracer.ts');
const { databaseTracer: dataBaseTracer } = require('./databaseTracer.ts');

const getHookerTracer = getHookedTracer;

function initRootSpan () {
  return new DummyTracing();
}

function tracingMiddleware (name = 'express1') {
  return function (req: Request & { tracing?: DummyTracingT }, res: Response, next: NextFunction) {
    if (req.tracing == null) {
      req.tracing = initRootSpan();
    }
    next();
  };
}

export { DummyTracing, dataBaseTracer, getHookerTracer, initRootSpan, tracingMiddleware };
