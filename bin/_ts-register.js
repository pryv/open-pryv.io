/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/*
 * .ts loader shim — Plan 57 incremental TS migration.
 *
 * Node 24 has native strip-types, but its CJS resolver only inspects
 * .js / .json / .node when given an extensionless require(). This shim
 * adds .ts to the resolver's lookup list so existing
 * `require('storages/interfaces/foo/Bar')` calls pick up Bar.ts during
 * incremental conversion.
 *
 * It also propagates a `--require` flag via NODE_OPTIONS so any
 * subsequent child_process.fork()/spawn() inherits the same loader
 * without each fork target having to require this shim explicitly.
 *
 * Drop this file once every consumer either uses an explicit '.ts'
 * extension or the runtime has flipped to ESM (Phase 5+).
 */

// 1. Register .ts in the current process's CJS resolver.
require.extensions['.ts'] = require.extensions['.js']; // eslint-disable-line n/no-deprecated-api

// 2. Propagate the loader to every child process spawned from here on.
//    Idempotent — `--require` is added at most once per process.
const path = require('path');
const SELF = path.resolve(__filename);
const FLAG = `--require=${SELF}`;
const current = process.env.NODE_OPTIONS || '';
if (!current.includes(FLAG)) {
  process.env.NODE_OPTIONS = current ? `${current} ${FLAG}` : FLAG;
}
