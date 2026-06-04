/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

// No-op tracing middleware. Was an opentracing-driven span/header injection
// layer; now a passthrough. Preserved as a registration slot so a future
// tracer can re-introduce per-request span lifecycle without touching
// hfs-server/src/server.js.

function tracingMiddleware (_ctx: unknown, _req: unknown, _res: unknown, next: (...a: unknown[]) => unknown) {
  return next();
}

function factory (ctx: unknown) {
  return (...rest: [unknown, unknown, (...a: unknown[]) => unknown]) => tracingMiddleware(ctx, ...rest);
}

export default factory;
