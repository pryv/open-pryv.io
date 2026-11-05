/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The suites that start their own rqlited (two cores, a two-node cluster)
 * need `bin-ext/rqlited`. Without it they FAIL: a run that silently skipped
 * them would read green with a whole block of tests never run. Skipping is
 * an explicit choice: `SKIP_2CORE=1`, and the skip says so.
 */

import fs from 'node:fs';

/** The variable that lets a run skip the suites that need rqlited. */
export const SKIP_2CORE_ENV = 'SKIP_2CORE';

/**
 * Call from the suite's `before` hook with its mocha context. Returns when
 * the binary is there; skips the suite when `SKIP_2CORE=1`; throws otherwise.
 */
export function requireRqlited (binPath: string, ctx: { skip: () => void }, suite: string): void {
  if (fs.existsSync(binPath)) return;
  if (process.env[SKIP_2CORE_ENV] === '1') {
    console.warn(`  SKIPPED ${suite}: ${SKIP_2CORE_ENV}=1 is set and rqlited is not at ${binPath}`);
    ctx.skip();
  }
  throw new Error(`${suite} needs rqlited at ${binPath}: run ./storages/engines/rqlite/scripts/setup ` +
    `(or link bin-ext/ as in the main checkout), or set ${SKIP_2CORE_ENV}=1 to skip these tests explicitly`);
}
