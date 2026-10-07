/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { authorFor } = require('../../src/author_scrub.ts');

/** [HASC] Which `modifiedBy` values hold a credential, and what they become. */
describe('[HASC] series author scrub', function () {
  const live = { id: 'acc-live', type: 'personal', live: true, token: 'tok-live' };
  const gone = { id: 'acc-gone', type: 'app', live: false, token: 'tok-gone' };
  const byToken = new Map([[live.token, live], [gone.token, gone]]);
  const ids = new Set([live.id, gone.id]);

  it('[HASC1] maps a bare token to its access id', function () {
    assert.deepStrictEqual(authorFor('tok-live', byToken, ids), { value: 'acc-live', access: live });
  });

  it('[HASC2] keeps a caller-id suffix', function () {
    assert.strictEqual(authorFor('tok-live caller-1', byToken, ids).value, 'acc-live caller-1');
  });

  it('[HASC3] handles a DPoP scheme prefix and a deleted access', function () {
    assert.strictEqual(authorFor('DPoP tok-gone', byToken, ids).value, 'acc-gone');
  });

  it('[HASC4] leaves access ids, unknown values and non-strings alone', function () {
    assert.strictEqual(authorFor('acc-live', byToken, ids), null);
    assert.strictEqual(authorFor('acc-live caller-1', byToken, ids), null);
    assert.strictEqual(authorFor('someone-else', byToken, ids), null);
    assert.strictEqual(authorFor('', byToken, ids), null);
    assert.strictEqual(authorFor(null, byToken, ids), null);
    assert.strictEqual(authorFor(undefined, byToken, ids), null);
  });
});
