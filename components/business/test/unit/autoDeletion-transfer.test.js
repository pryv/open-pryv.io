/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ATRU] account transfer, the pure part: the links (derived, never stored),
 * when the claim window needs a mail or has ended, the account-app links.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { deriveLinkToken, linkTokenMatches, newSalt, claimMailDue, windowEnded, accountAppLink } = require('../../src/autoDeletion/transfer.ts');
const { resolveLinkKey, resolveIdentityKey, isOpenTransfer } = require('../../src/autoDeletion/state.ts');

const DAY = 24 * 60 * 60;
const T0 = 1800000000;

describe('[ATRU] account transfer (pure)', function () {
  const key = crypto.randomBytes(32);

  it('[ATRU1] a link is bound to its kind, account and salt, and checked in constant time', function () {
    const salt = newSalt();
    const token = deriveLinkToken(key, 'claim', 'user-1', salt);
    assert.equal(token, deriveLinkToken(key, 'claim', 'user-1', salt), 'the same link when re-sent');
    assert.ok(linkTokenMatches(key, 'claim', 'user-1', salt, token));
    assert.ok(!linkTokenMatches(key, 'decline', 'user-1', salt, token), 'another kind');
    assert.ok(!linkTokenMatches(key, 'claim', 'user-2', salt, token), 'another account');
    assert.ok(!linkTokenMatches(key, 'claim', 'user-1', newSalt(), token), 'a new transfer');
    assert.ok(!linkTokenMatches(crypto.randomBytes(32), 'claim', 'user-1', salt, token), 'another key');
    for (const bad of [undefined, null, '', 42, token.slice(1), 'x'.repeat(201)]) {
      assert.ok(!linkTokenMatches(key, 'claim', 'user-1', salt, bad), String(bad));
    }
    assert.ok(!linkTokenMatches(key, 'claim', 'user-1', undefined, token), 'no salt: nothing matches');
  });

  it('[ATRU2] the link key comes from the dedicated key, else the admin key, for its own purpose', function () {
    const secrets = crypto.randomBytes(32).toString('base64');
    assert.ok(resolveLinkKey(secrets, 'admin').equals(resolveLinkKey(secrets, 'other admin')), 'the dedicated key wins');
    assert.ok(!resolveLinkKey(null, 'admin').equals(resolveLinkKey(null, 'other admin')));
    assert.ok(!resolveLinkKey(null, 'admin').equals(resolveIdentityKey(null, 'admin')), 'not the identity key');
    assert.equal(resolveLinkKey(null, null), null);
  });

  it('[ATRU3] the claim mail: the first one, then once at +30 and +60 days, never after the window', function () {
    const open = { email: 'b@x.example', status: 'open', createdAt: T0, openedAt: T0, endsAt: T0 + 90 * DAY, claimSalt: 's', claimMailsSent: [] };
    assert.equal(claimMailDue(open, T0), 'initial');
    const one = { ...open, claimMailsSent: [T0] };
    assert.equal(claimMailDue(one, T0 + 29 * DAY), null);
    assert.equal(claimMailDue(one, T0 + 30 * DAY), 'resend');
    const two = { ...open, claimMailsSent: [T0, T0 + 30 * DAY] };
    assert.equal(claimMailDue(two, T0 + 59 * DAY), null);
    assert.equal(claimMailDue(two, T0 + 61 * DAY), 'resend');
    assert.equal(claimMailDue({ ...open, claimMailsSent: [T0, 1, 2] }, T0 + 89 * DAY), null);
    assert.equal(claimMailDue(one, T0 + 90 * DAY), null, 'the window ended');
    assert.equal(claimMailDue({ ...one, status: 'claimed' }, T0 + 30 * DAY), null, 'claimed: no more claim mail');
  });

  it('[ATRU4] the window ends at its end, open or claimed; closed records never end again', function () {
    const open = { email: 'b@x.example', status: 'open', createdAt: T0, openedAt: T0, endsAt: T0 + 90 * DAY };
    assert.equal(windowEnded(open, T0 + 90 * DAY - 1), false);
    assert.equal(windowEnded(open, T0 + 90 * DAY), true);
    assert.equal(windowEnded({ ...open, status: 'claimed' }, T0 + 91 * DAY), true);
    for (const status of ['named', 'completed', 'lapsed', 'cancelled', 'declined', 'fallback-delete']) {
      assert.equal(windowEnded({ ...open, status }, T0 + 91 * DAY), false, status);
    }
    assert.ok(isOpenTransfer({ ...open, status: 'named' }) && isOpenTransfer({ ...open, status: 'claimed' }));
    assert.ok(!isOpenTransfer({ ...open, status: 'completed' }) && !isOpenTransfer(null));
  });

  it('[ATRU5] account-app links keep the query the operator configured', function () {
    assert.equal(accountAppLink('https://a.example/', 'transfer-claim', { username: 'u', token: 't' }), 'https://a.example/transfer-claim?username=u&token=t');
    assert.equal(accountAppLink('https://a.example/app', 'transfer-claim', { username: 'u', token: 't' }), 'https://a.example/app/transfer-claim?username=u&token=t');
    assert.equal(accountAppLink('https://a.example/?pryvServiceInfoUrl=https%3A%2F%2Freg.example%2Fservice%2Finfo', 'transfer-decline', { username: 'u', token: 't-_' }),
      'https://a.example/transfer-decline?pryvServiceInfoUrl=https%3A%2F%2Freg.example%2Fservice%2Finfo&username=u&token=t-_');
  });
});
