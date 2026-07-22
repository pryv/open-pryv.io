/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — item lifecycle unit tests.
 *
 * The transition and view functions decide what survives at rest and what a
 * status read reports, so they are worth pinning without a server in the way.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { applyTransition, toPublicView, isPending } = require('../src/item.ts');

function pendingContent (over = {}) {
  return Object.assign({
    keyHash: 'a'.repeat(64),
    title: 't',
    status: 'pending',
    statusHistory: [{ status: 'pending', time: 100 }],
    onConsumed: { message: 'gone' },
    secret: { token: 'live' }
  }, over);
}

describe('[SHSI-U] shared-secret item lifecycle', function () {
  describe('[SHSI-U-T] applyTransition', function () {
    it('[SS07] scrubs the secret and the signature value, keeps the type', function () {
      const before = pendingContent({ signature: { type: 'secret', value: 'passphrase' } });
      const after = applyTransition(before, { status: 'consumed', now: 200 });
      assert.equal(after.secret, undefined);
      assert.equal(after.signature.value, undefined);
      assert.equal(after.signature.type, 'secret', 'the type stays for the record');
      assert.equal(after.status, 'consumed');
    });

    it('[SS08] appends exactly one history entry, oldest first', function () {
      const after = applyTransition(pendingContent(), { status: 'discarded', info: 'deleted', now: 300 });
      assert.equal(after.statusHistory.length, 2);
      assert.deepEqual(after.statusHistory[1], { status: 'discarded', time: 300, info: 'deleted' });
    });

    it('[SS09] does not mutate the input', function () {
      const before = pendingContent();
      applyTransition(before, { status: 'consumed', now: 200 });
      assert.equal(before.secret.token, 'live', 'the original content is untouched');
      assert.equal(before.statusHistory.length, 1);
    });

    it('[SS10] a transition with no signature leaves the shape valid', function () {
      const after = applyTransition(pendingContent(), { status: 'consumed', now: 200 });
      assert.equal(after.signature, undefined);
    });
  });

  describe('[SHSI-U-V] toPublicView', function () {
    const event = { id: 'e1', time: 1000, duration: 300, content: pendingContent() };

    it('[SS11] never exposes the secret or the key hash', function () {
      const view = toPublicView(event);
      assert.equal(view.secret, undefined);
      assert.equal(view.keyHash, undefined);
      assert.equal(view.expires, 1300);
    });

    it('[SS12] without now, reports the stored status verbatim', function () {
      const view = toPublicView(event, undefined);
      assert.equal(view.status, 'pending');
      assert.notEqual(view.expired, true);
    });

    it('[SS13] with now past expiry, reports a pending item as expired', function () {
      const view = toPublicView(event, 1301);
      assert.equal(view.status, 'discarded');
      assert.equal(view.expired, true);
    });

    it('[SS14] the boundary instant is still live', function () {
      const view = toPublicView(event, 1300);
      assert.equal(view.status, 'pending');
      assert.notEqual(view.expired, true);
    });

    it('[SS15] a terminal item is reported as-is, never re-labelled', function () {
      const consumed = { ...event, content: pendingContent({ status: 'consumed' }) };
      const view = toPublicView(consumed, 9e9);
      assert.equal(view.status, 'consumed', 'expiry override only applies to pending');
      assert.notEqual(view.expired, true);
    });
  });

  it('[SS16] isPending is true only for the pending status', function () {
    assert.equal(isPending(pendingContent()), true);
    assert.equal(isPending(pendingContent({ status: 'consumed' })), false);
    assert.equal(isPending(null), false);
  });
});
