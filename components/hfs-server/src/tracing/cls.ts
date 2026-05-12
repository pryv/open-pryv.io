/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

// No-op CLS shim. Was a cls-hooked wrapper for span continuation across async
// boundaries; now a passthrough. Preserved as an export so the express
// middleware and Context.childSpan callers need no edits when a future tracer
// re-introduces continuation-local-storage.

class Cls {
  setRootSpan () {}
  getRootSpan () { return null; }
  startExpressContext (_req: any, _res: any, next: any) { return next(); }
}

const cls = new Cls();
export default cls;
export { cls };
