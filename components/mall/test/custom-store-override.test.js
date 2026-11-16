/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');

const { planCustomStores, BUILT_IN_STORE_IDS } = require('../src/index.ts');

describe('[CSOV] custom:dataStores entries and the built-in store ids', () => {
  const def = (id, extra = {}) => ({ id, name: id + ' store', path: '/x/' + id, ...extra });

  it('[CSOV1] an entry with its own id is registered ahead of the built-ins', () => {
    const plan = planCustomStores([def('dummy'), def('ext', { override: true })]);
    assert.deepStrictEqual(plan.before.map((d) => d.id), ['dummy', 'ext']);
    assert.deepStrictEqual(plan.replacing, []);
    assert.deepStrictEqual(plan.ignored, []);
  });

  it('[CSOV2] an entry using a built-in id without `override: true` is ignored, whatever the id', () => {
    const plan = planCustomStores(BUILT_IN_STORE_IDS.map((id) => def(id)).concat([def('_audit', { override: 'yes' })]));
    assert.deepStrictEqual(plan.ignored.map((d) => d.id), ['local', 'account', '_audit', '_audit']);
    assert.deepStrictEqual(plan.before, []);
    assert.deepStrictEqual(plan.replacing, []);
  });

  it('[CSOV3] an entry using a built-in id with `override: true` replaces it, registered after the built-ins', () => {
    const plan = planCustomStores([def('_audit', { override: true }), def('dummy')]);
    assert.deepStrictEqual(plan.replacing.map((d) => d.id), ['_audit']);
    assert.deepStrictEqual(plan.before.map((d) => d.id), ['dummy']);
  });

  it('[CSOV4] no entries, or none configured', () => {
    for (const defs of [[], null, undefined]) {
      assert.deepStrictEqual(planCustomStores(defs), { before: [], replacing: [], ignored: [] });
    }
  });
});
