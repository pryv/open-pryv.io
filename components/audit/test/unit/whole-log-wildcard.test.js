/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

const { wholeLogAsWildcard } = require('audit/src/datastore/auditUserEvents.ts');

describe('[WLW] audit: the actions parent reads the whole log', function () {
  it('[WLW1] an `any` naming `actions` (plus its expanded children, or with `accesses`) becomes `*`', function () {
    assert.deepStrictEqual(
      wholeLogAsWildcard([[{ any: ['actions', 'action-events.get'] }], [{ any: ['access-a'] }]]),
      [[{ any: ['*'] }], [{ any: ['access-a'] }]]);
    assert.deepStrictEqual(
      wholeLogAsWildcard([[{ any: ['accesses', 'access-a', 'actions', 'action-x'] }]]),
      [[{ any: ['*'] }]]);
  });

  it('[WLW2] keeps `not` items and `any` items without the parent', function () {
    assert.deepStrictEqual(
      wholeLogAsWildcard([[{ any: ['actions', 'action-y'] }, { any: ['access-a'] }, { not: ['access-b'] }]]),
      [[{ any: ['*'] }, { any: ['access-a'] }, { not: ['access-b'] }]]);
  });

  it('[WLW3] leaves `accesses` and children-only queries untouched (some rows have no access)', function () {
    const accesses = [[{ any: ['accesses', 'access-a', 'access-b'] }]];
    assert.deepStrictEqual(wholeLogAsWildcard(accesses), accesses);
    const children = [[{ any: ['action-x', 'action-y'] }]];
    assert.deepStrictEqual(wholeLogAsWildcard(children), children);
    assert.strictEqual(wholeLogAsWildcard(undefined), undefined);
  });

  it('[WLW4] a bare string block naming the parent becomes an iterable block', function () {
    assert.deepStrictEqual(wholeLogAsWildcard(['actions', 'access-a']), [[{ any: ['*'] }], 'access-a']);
  });
});
