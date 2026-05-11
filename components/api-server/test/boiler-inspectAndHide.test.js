/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

const { inspectAndHide } = require('@pryv/boiler/src/logging.ts');

describe('[BIH] boiler/logging inspectAndHide', function () {
  it('[BIH1] passes through `undefined` without throwing', function () {
    assert.strictEqual(inspectAndHide(undefined), undefined);
  });

  it('[BIH2] passes through functions without throwing', function () {
    const fn = () => 42;
    // Pre-fix: JSON.parse(JSON.stringify(fn)) → JSON.parse(undefined) →
    // SyntaxError. Worker bootstrap crashed the api-server process on
    // any logger.{debug,info,warn,error}(message, function) call.
    assert.doesNotThrow(() => inspectAndHide(fn));
    assert.strictEqual(inspectAndHide(fn), fn);
  });

  it('[BIH3] passes through symbols without throwing', function () {
    const sym = Symbol('s');
    assert.doesNotThrow(() => inspectAndHide(sym));
    assert.strictEqual(inspectAndHide(sym), sym);
  });

  it('[BIH4] passes through objects whose toJSON returns undefined', function () {
    // class { toJSON () { return undefined; } } — JSON.stringify yields
    // undefined, same crash shape as raw functions/symbols.
    const obj = { toJSON: () => undefined };
    assert.doesNotThrow(() => inspectAndHide(obj));
    // Fallback returns the original value when JSON round-trip fails.
    assert.strictEqual(inspectAndHide(obj), obj);
  });

  it('[BIH5] passes through Error instances unchanged', function () {
    const err = new Error('boom');
    assert.strictEqual(inspectAndHide(err), err);
  });

  it('[BIH6] hides sensitive fields in plain objects', function () {
    const masked = inspectAndHide({ user: 'alice', password: 'secret123' });
    assert.strictEqual(masked.user, 'alice');
    assert.strictEqual(masked.password, '(hidden password)');
  });
});
