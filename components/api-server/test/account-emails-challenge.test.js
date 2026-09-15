/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Registration email challenge, business layer (Pattern C).
 *
 * The challenge proves control of an address before any account exists, so it
 * lives in the cluster-wide PlatformDB TTL store rather than on an event. These
 * tests drive the module directly and read the raw rows back, so they can assert
 * what is actually persisted: hashes, never the plaintext code or proof.
 *
 * The code is short enough to retype, so the security argument rests on the
 * attempt budgets rather than on entropy. Several cases below exist only to pin
 * those budgets, including the concurrent one.
 */

/* global initTests, initCore, assert, cuid, config */

const challenge = require('business/src/emails/challenge.ts');
const { hashToken } = require('business/src/emails/tokens.ts');

const CFG = {
  maxAge: 'account:emailVerification:registrationCodeMaxAgeMs',
  attempts: 'account:emailVerification:registrationCodeMaxAttempts',
  cooldown: 'account:emailVerification:registrationCodeResendCooldownMs',
  daily: 'account:emailVerification:registrationCodeDailyLimit',
  fails: 'account:emailVerification:registrationCodeFailuresPerDay',
  proofAge: 'account:emailVerification:registrationProofMaxAgeMs'
};

describe('[EMCH] registration email challenge', function () {
  this.timeout(30000);
  let platformDB;
  let saved;

  before(async function () {
    await initTests();
    await initCore();
    platformDB = require('storages').platformDB;
    saved = {};
    for (const key of Object.values(CFG)) saved[key] = config.get(key);
    // Most cases are not about the cooldown; the ones that are set it themselves.
    config.set(CFG.cooldown, 0);
  });

  after(function () {
    for (const [key, value] of Object.entries(saved)) config.set(key, value);
  });

  afterEach(function () {
    config.set(CFG.cooldown, 0);
    config.set(CFG.attempts, saved[CFG.attempts]);
    config.set(CFG.maxAge, saved[CFG.maxAge]);
    config.set(CFG.daily, saved[CFG.daily]);
    config.set(CFG.fails, saved[CFG.fails]);
  });

  /** A fresh address per case, so the per-address budgets never interfere. */
  function anEmail () {
    return cuid() + '@ch.example.com';
  }

  async function rawRow (email) {
    return await platformDB.getAccessState(challenge.challengeKey(email));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('[EMCH1] mints a code from the unambiguous alphabet and stores only its hash', async function () {
    const email = anEmail();
    const before = Date.now();
    const out = await challenge.createChallenge(email);
    assert.strictEqual(out.ok, true);
    assert.match(out.code, /^[A-Z2-9]{8}$/);
    for (const c of out.code) {
      assert.ok(challenge.CODE_ALPHABET.includes(c), `${c} is not in the alphabet`);
    }
    const row = await rawRow(email);
    assert.strictEqual(row.value.kind, 'challenge');
    assert.strictEqual(row.value.codeHash, hashToken(out.code));
    assert.strictEqual(row.value.attempts, 0);
    assert.ok(!JSON.stringify(row).includes(out.code), 'the plaintext code must never be persisted');
    const expected = before + config.get(CFG.maxAge);
    assert.ok(Math.abs(row.expiresAt - expected) < 2000, 'expiry follows the configured max age');
  });

  it('[EMCH2] a correct code turns the row into a proof row and drops the code hash', async function () {
    const email = anEmail();
    const created = await challenge.createChallenge(email);
    const before = Date.now();
    const out = await challenge.verifyChallenge(email, created.code);
    assert.strictEqual(out.ok, true);
    assert.ok(out.proof.length > 30);
    const row = await rawRow(email);
    assert.strictEqual(row.value.kind, 'proof');
    assert.strictEqual(row.value.proofHash, hashToken(out.proof));
    assert.strictEqual(row.value.codeHash, undefined, 'a proof row holds no code hash');
    assert.ok(!JSON.stringify(row).includes(out.proof), 'the plaintext proof must never be persisted');
    const expected = before + config.get(CFG.proofAge);
    assert.ok(Math.abs(row.expiresAt - expected) < 2000, 'expiry follows the proof max age');
  });

  it('[EMCH3] wrong codes count down and the code is spent when they run out', async function () {
    config.set(CFG.attempts, 3);
    const email = anEmail();
    const created = await challenge.createChallenge(email);
    assert.deepStrictEqual(await challenge.verifyChallenge(email, 'AAAAAAAA'),
      { ok: false, reason: 'wrong-code', attemptsRemaining: 2 });
    assert.deepStrictEqual(await challenge.verifyChallenge(email, 'AAAAAAAA'),
      { ok: false, reason: 'wrong-code', attemptsRemaining: 1 });
    assert.deepStrictEqual(await challenge.verifyChallenge(email, 'AAAAAAAA'),
      { ok: false, reason: 'exhausted', attemptsRemaining: 0 });
    // Even the RIGHT code no longer works: the holder must request another.
    assert.deepStrictEqual(await challenge.verifyChallenge(email, created.code),
      { ok: false, reason: 'no-challenge', attemptsRemaining: 0 });
  });

  it('[EMCH4] concurrent guesses are counted exactly, never over- or under-counted', async function () {
    // Why verify CONSUMES the row before checking the code: a get-then-set
    // implementation lets N concurrent wrong guesses all read attempts=0 and
    // burn one attempt between them. Consuming makes the row the lock, so
    // exactly one caller of each racing batch is evaluated and the losers get
    // nothing back. Firing guesses in parallel therefore gains an attacker
    // nothing: it costs them guesses rather than saving them.
    config.set(CFG.attempts, 5);
    const email = anEmail();
    await challenge.createChallenge(email);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => challenge.verifyChallenge(email, 'AAAAAAAA'))
    );
    const counted = results.filter((r) => r.reason === 'wrong-code' || r.reason === 'exhausted');
    const lost = results.filter((r) => r.reason === 'no-challenge');
    assert.strictEqual(counted.length + lost.length, 20, 'every call returns one of the two shapes');
    assert.ok(counted.length >= 1, 'at least one guess is evaluated');
    assert.ok(counted.length <= 5, `never more than maxAttempts, got ${counted.length}`);

    // Exactness: the row records precisely the guesses that were evaluated.
    const row = await rawRow(email);
    if (row != null) {
      assert.strictEqual(row.value.attempts, counted.length,
        'the persisted attempt count equals the number of evaluated guesses');
    } else {
      assert.strictEqual(counted.length, 5, 'the row is only discarded once the budget is spent');
    }

    // And the budget really does end the code, sequentially this time.
    for (let i = 0; i < 5; i++) await challenge.verifyChallenge(email, 'AAAAAAAA');
    assert.strictEqual(await rawRow(email), null, 'the row is gone once the budget is spent');
  });

  it('[EMCH5] the pasted code is accepted in any case, with or without the separator', async function () {
    const email = anEmail();
    const created = await challenge.createChallenge(email);
    const pasted = challenge.formatCode(created.code).toLowerCase();
    const out = await challenge.verifyChallenge(email, pasted);
    assert.strictEqual(out.ok, true);
  });

  it('[EMCH6] an expired code is gone', async function () {
    config.set(CFG.maxAge, 1);
    const email = anEmail();
    const created = await challenge.createChallenge(email);
    await sleep(20);
    assert.deepStrictEqual(await challenge.verifyChallenge(email, created.code),
      { ok: false, reason: 'no-challenge', attemptsRemaining: 0 });
  });

  it('[EMCH7] requesting a second code invalidates the first', async function () {
    const email = anEmail();
    const first = await challenge.createChallenge(email);
    const second = await challenge.createChallenge(email);
    const outFirst = await challenge.verifyChallenge(email, first.code);
    assert.strictEqual(outFirst.ok, false, 'the superseded code must not verify');
    const outSecond = await challenge.verifyChallenge(email, second.code);
    assert.strictEqual(outSecond.ok, true);
  });

  it('[EMCH8] a second code within the cooldown is refused', async function () {
    config.set(CFG.cooldown, 60000);
    const email = anEmail();
    assert.strictEqual((await challenge.createChallenge(email)).ok, true);
    assert.deepStrictEqual(await challenge.createChallenge(email),
      { ok: false, reason: 'cooldown', retryAfterSeconds: 60 });
  });

  it('[EMCH9] the daily cap stops bulk requests for one address', async function () {
    config.set(CFG.daily, 2);
    const email = anEmail();
    assert.strictEqual((await challenge.createChallenge(email)).ok, true);
    assert.strictEqual((await challenge.createChallenge(email)).ok, true);
    const third = await challenge.createChallenge(email);
    assert.strictEqual(third.ok, false);
    assert.strictEqual(third.reason, 'daily-limit');
    assert.ok(third.retryAfterSeconds > 0);
  });

  it('[EMCH10] the daily failure budget blocks NEW codes, so guessing cannot reset the counter', async function () {
    config.set(CFG.fails, 2);
    config.set(CFG.attempts, 5);
    const email = anEmail();
    await challenge.createChallenge(email);
    await challenge.verifyChallenge(email, 'AAAAAAAA');
    await challenge.verifyChallenge(email, 'AAAAAAAA');
    const out = await challenge.createChallenge(email);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'failure-budget');
  });

  it('[EMCH11] the proof is checkable without consuming it, and single-use once consumed', async function () {
    const email = anEmail();
    const created = await challenge.createChallenge(email);
    const verified = await challenge.verifyChallenge(email, created.code);
    assert.strictEqual(await challenge.checkProof(email, verified.proof), true);
    assert.strictEqual(await challenge.checkProof(email, verified.proof), true, 'check must not consume');
    assert.strictEqual(await challenge.checkProof(email, 'not-the-proof'), false);
    await challenge.consumeProof(email);
    assert.strictEqual(await challenge.checkProof(email, verified.proof), false);
  });

  it('[EMCH12] the row key is a hash of the normalised address, never the address', async function () {
    const key = challenge.challengeKey('Alice@Example.com');
    assert.strictEqual(key, 'email-challenge/' + hashToken('alice@example.com'));
    assert.match(key, /^email-challenge\/[0-9a-f]{64}$/);
    assert.ok(!key.includes('Alice'), 'no cleartext address in a cluster-wide key');
  });

  it('[EMCH13] discarding a challenge frees the cooldown, so a failed send is not a lockout', async function () {
    config.set(CFG.cooldown, 60000);
    const email = anEmail();
    assert.strictEqual((await challenge.createChallenge(email)).ok, true);
    await challenge.discardChallenge(email);
    assert.strictEqual((await challenge.createChallenge(email)).ok, true, 'a discarded send must not burn the cooldown');
  });
});
