/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * nock >= 14 activates on `require('nock')` and then routes every
 * `http.request` / `fetch` of the process through a mock socket. Mocha loads
 * every spec file before running any, so without these hooks nock is active
 * for all suites, and a suite whose own `before`/`after` never run (filtered
 * out by `--grep`) never switches it off. Socket-level tests then silently
 * test the mock instead of Node.
 *
 * - `useNock()`: call inside the `describe` of a suite that mocks HTTP. Every
 *   request made inside that suite, local ones included, goes through the
 *   interceptor, so tests about real socket behaviour belong outside it.
 * - `nockMochaHooks`: root hooks that switch nock off at startup and, around
 *   every test outside a `useNock()` suite, switch it off again if something
 *   left it on, then fail the run at the end naming the tests involved.
 */

// Mocha globals, present at runtime in every spec process.
declare const before: (fn: (this: any) => void) => void;
declare const after: (fn: () => void) => void;

const USES_NOCK = Symbol('usesNock');

/** nock's exports if some spec already loaded it, without loading it here. */
function loadedNock (): any {
  let resolved: string;
  try {
    resolved = require.resolve('nock');
  } catch (_e) {
    return null;
  }
  return require.cache[resolved]?.exports ?? null;
}

function switchOff (nock: any): void {
  nock.cleanAll();
  nock.enableNetConnect();
  nock.restore();
}

function useNock (): void {
  before(function (this: any) {
    if (this.test.parent.root) throw new Error('useNock() must be called inside a describe()');
    this.test.parent[USES_NOCK] = true;
    const nock = require('nock');
    if (!nock.isActive()) nock.activate();
  });
  after(function () {
    switchOff(require('nock'));
  });
}

const leaks: string[] = [];

/** Switches nock off and records `label` when it is on outside a useNock() suite. */
function checkOutsideUseNock (test: any, label: string): void {
  const nock = loadedNock();
  if (nock == null || !nock.isActive()) return;
  for (let suite = test?.parent; suite != null; suite = suite.parent) {
    if (suite[USES_NOCK]) return;
  }
  leaks.push(label + test.fullTitle());
  switchOff(nock);
}

const nockMochaHooks = {
  beforeAll (): void {
    const nock = loadedNock();
    if (nock?.isActive()) nock.restore();
  },
  beforeEach (this: any): void {
    checkOutsideUseNock(this.currentTest, 'on before: ');
  },
  afterEach (this: any): void {
    checkOutsideUseNock(this.currentTest, 'left on by: ');
  },
  afterAll (): void {
    // Parallel workers run root hooks once per file: report each leak once.
    const found = leaks.splice(0);
    if (found.length === 0) return;
    throw new Error('nock was active outside a useNock() suite (switched off each time; ' +
      'wrap the suite that mocks HTTP with useNock()):\n  ' + found.join('\n  '));
  }
};

export { useNock, nockMochaHooks };
