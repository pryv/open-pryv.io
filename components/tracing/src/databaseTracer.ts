/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


// No-op shim. Was a Jaeger-driven monkey-patcher of database method callbacks;
// now a passthrough. Preserved as an export of components/tracing/ so callers
// in storages/index.js and components/storage/src/index.js need no edits.

function databaseTracer () {}
export { databaseTracer };
