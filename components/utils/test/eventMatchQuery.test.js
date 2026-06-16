/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { matchesStreamQuery, eventMatchesQuery } = require('../src/eventMatchQuery.ts');
const assert = require('node:assert');

describe('[SNMQ] eventMatchQuery', function () {
  describe('[SNMS] matchesStreamQuery', function () {
    it('[SNMS1] matches when an `any` streamId is present', function () {
      assert.strictEqual(matchesStreamQuery(['a', 'b'], [{ any: ['b'] }]), true);
      assert.strictEqual(matchesStreamQuery(['a', 'b'], [{ any: ['z'] }]), false);
    });
    it('[SNMS2] excludes when a `not` streamId is present', function () {
      assert.strictEqual(matchesStreamQuery(['a', 'b'], [[{ any: ['a'] }, { not: ['b'] }]]), false);
      assert.strictEqual(matchesStreamQuery(['a', 'c'], [[{ any: ['a'] }, { not: ['b'] }]]), true);
    });
    it('[SNMS3] OR between groups', function () {
      const groups = [{ any: ['x'] }, { any: ['b'] }];
      assert.strictEqual(matchesStreamQuery(['a', 'b'], groups), true);
    });
    it('[SNMS4] accepts a single-condition object as a group', function () {
      assert.strictEqual(matchesStreamQuery(['a'], [{ any: ['a'] }]), true);
    });
  });

  describe('[SNMC] eventMatchesQuery composition', function () {
    const event = { streamIds: ['diary', 'notes'], type: 'note/txt', content: { status: 'unread', n: 5 }, clientData: { appId: 'x' } };

    it('[SNMC1] empty query matches any event', function () {
      assert.strictEqual(eventMatchesQuery(event, {}), true);
    });
    it('[SNMC2] streams dimension', function () {
      assert.strictEqual(eventMatchesQuery(event, { streams: [{ any: ['diary'] }] }), true);
      assert.strictEqual(eventMatchesQuery(event, { streams: [{ any: ['health'] }] }), false);
    });
    it('[SNMC3] types dimension', function () {
      assert.strictEqual(eventMatchesQuery(event, { types: ['note/txt'] }), true);
      assert.strictEqual(eventMatchesQuery(event, { types: ['mass/kg'] }), false);
    });
    it('[SNMC4] content conditions', function () {
      assert.strictEqual(eventMatchesQuery(event, { content: [{ field: 'content', path: ['status'], op: 'eq', value: 'unread' }] }), true);
      assert.strictEqual(eventMatchesQuery(event, { content: [{ field: 'content', path: ['n'], op: 'gt', value: 10 }] }), false);
    });
    it('[SNMC5] clientData conditions', function () {
      assert.strictEqual(eventMatchesQuery(event, { clientData: [{ field: 'clientData', path: ['appId'], op: 'eq', value: 'x' }] }), true);
      assert.strictEqual(eventMatchesQuery(event, { clientData: [{ field: 'clientData', path: ['appId'], op: 'eq', value: 'y' }] }), false);
    });
    it('[SNMC6] all dimensions AND together', function () {
      const q = {
        streams: [{ any: ['diary'] }],
        types: ['note/txt'],
        content: [{ field: 'content', path: ['status'], op: 'eq', value: 'unread' }]
      };
      assert.strictEqual(eventMatchesQuery(event, q), true);
      // one dimension fails -> whole match fails
      assert.strictEqual(eventMatchesQuery(event, { ...q, types: ['mass/kg'] }), false);
    });
  });
});
