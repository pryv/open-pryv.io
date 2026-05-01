/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

// No-op shim. Was a wrapper that stitched async_hooks-tracked spans into the
// opentracing API; now a passthrough. The architectural slot is preserved so a
// future tracer can re-introduce hooked spans without touching consumers.

class HookedTracer {
  tag () {}
  finish () {}
  finishOnCallBack (cb) { return cb; }
}

module.exports.getHookedTracer = () => new HookedTracer();
