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

import type { Request, Response, NextFunction } from 'express';
import type { DummyTracing as DummyTracingT } from './Tracing.ts';
import { DummyTracing } from './Tracing.ts';
import { getHookedTracer } from './HookedTracer.ts';
import { databaseTracer as dataBaseTracer } from './databaseTracer.ts';

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
