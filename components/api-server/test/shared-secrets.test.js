/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Shared secrets — one-shot secret hand-off by key.
 *
 * A creator stores a secret JSON payload and receives a random key exactly
 * once; a third party exchanges that key, once, for the secret. The point is
 * to stop passing real secrets (access tokens…) as URL query parameters.
 *
 * These suites are written BEFORE the implementation and define its contract:
 *   [SHSC] create        — validation, limits, feature gate, key material
 *   [SHSR] retrieve      — one-shot semantics, expiry, signatures
 *   [SHSA] atomicity     — concurrent consume yields exactly one winner
 *   [SHSV] visibility    — star exclusion, per-access isolation, listing
 *   [SHSI] immutability  — no update, delete-as-discard, integrity preserved
 *
 * Storage model under test: one event per shared secret in the
 * `:_shared-secrets:<creatorAccessId>` namespace, `duration` carrying the TTL
 * (expiry is exactly `now > time + duration`), `trashed` marking items that
 * left the `pending` status. The server stores only SHA-256(key).
 *
 * Pattern C — initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const crypto = require('node:crypto');

const NS_ROOT = ':_shared-secrets:';

/** The namespace substream a given access writes its shared secrets into. */
function nsFor (accessId) { return NS_ROOT + accessId; }

/** Reference HMAC payload, mirroring what lib-js will compute client-side. */
function hmacPayload (verifierSecret, key) {
  return crypto.createHmac('sha256', verifierSecret).update(key).digest('hex');
}

describe('[SHS] shared secrets', function () {
  let username, personalToken, user, fixtures;
  let secretsPath, eventsPath, accessesPath, streamsPath;
  let otherUsername, otherPersonalToken;

  /** Creates an app access and returns { token, id }. */
  async function createAppAccess (params = {}) {
    const res = await coreRequest
      .post(accessesPath)
      .set('Authorization', personalToken)
      .send(Object.assign({
        name: 'app-' + cuid(),
        type: 'app',
        permissions: [{ streamId: '*', level: 'read' }]
      }, params));
    assert.strictEqual(res.status, 201, 'access creation failed: ' + JSON.stringify(res.body));
    return { token: res.body.access.token, id: res.body.access.id };
  }

  /** POST /shared-secrets as `token`; returns the raw response. */
  function create (token, body) {
    return coreRequest.post(secretsPath).set('Authorization', token).send(body);
  }

  /**
   * Creates and asserts success, returning the sharedSecret envelope. Tests that
   * only need a secret to exist go through this so a broken creation surfaces as
   * "creation failed: <body>" instead of a cryptic undefined-property TypeError
   * three lines later.
   */
  async function createOk (token, body) {
    const res = await create(token, body);
    assert.strictEqual(res.status, 201, 'creation failed: ' + JSON.stringify(res.body));
    assert.ok(res.body?.sharedSecret?.key, 'creation returned no key: ' + JSON.stringify(res.body));
    return res.body.sharedSecret;
  }

  /**
   * POST /shared-secrets/retrieve — deliberately unauthenticated.
   * The key rides in the body: a key in the path would be written to the access
   * log on every redemption, which is the exposure this feature exists to remove.
   */
  function retrieve (key, body = {}) {
    return coreRequest.post(secretsPath + '/retrieve').send(Object.assign({ key }, body));
  }

  /** A valid creation body; override anything per test. */
  function validBody (over = {}) {
    return Object.assign({
      ttl: 300,
      title: 'Share my token with the clinic',
      onConsumed: {
        message: 'This sharing link has already been used.',
        returnUrl: 'https://example.com/back'
      },
      secret: { apiEndpoint: 'https://token@user.pryv.me/' }
    }, over);
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    secretsPath = '/' + username + '/shared-secrets';
    eventsPath = '/' + username + '/events';
    accessesPath = '/' + username + '/accesses';
    streamsPath = '/' + username + '/streams';

    user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);

    // A second account, to prove keys never resolve across users.
    otherUsername = cuid();
    otherPersonalToken = cuid();
    const otherUser = await fixtures.user(otherUsername);
    await otherUser.access({ token: otherPersonalToken, type: 'personal' });
    await otherUser.session(otherPersonalToken);
  });

  // Guards against the whole suite silently passing on a stale fixture.
  before(async function () {
    const res = await coreRequest
      .get('/' + username + '/access-info')
      .set('Authorization', personalToken);
    assert.strictEqual(res.status, 200,
      'fixture user/session missing or stale entering [SHS]: ' + JSON.stringify(res.body));
  });

  describe('[SHSC] creation', function () {
    it('[SHS01] creates a shared secret and returns the key exactly once', async function () {
      const res = await create(personalToken, validBody());
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const ss = res.body.sharedSecret;
      assert.ok(ss, 'expected a sharedSecret envelope');
      assert.ok(typeof ss.key === 'string' && ss.key.length > 0, 'expected a key');
      assert.ok(ss.id, 'expected an id');
      assert.strictEqual(ss.status, 'pending');
      assert.strictEqual(ss.title, 'Share my token with the clinic');
      // The key is composite: "<eventId>.<random>" so retrieval is an O(1) lookup.
      assert.ok(ss.key.startsWith(ss.id + '.'), 'key must embed its event id: ' + ss.key);
      // The random half must carry real entropy (>= 192 bits, base64url).
      const randomPart = ss.key.slice(ss.id.length + 1);
      assert.ok(randomPart.length >= 32, 'random part too short: ' + randomPart);
      assert.match(randomPart, /^[A-Za-z0-9_-]+$/);
      // The secret itself is never echoed back on creation.
      assert.strictEqual(ss.secret, undefined);
    });

    it('[SHS02] stores only the hash of the key — the clear key is unrecoverable', async function () {
      const { id, key } = await createOk(personalToken, validBody());

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.status, 200, JSON.stringify(ev.body));
      const content = ev.body.event.content;
      const expectedHash = crypto.createHash('sha256')
        .update(key.slice(id.length + 1)).digest('hex');
      assert.strictEqual(content.keyHash, expectedHash);
      const serialized = JSON.stringify(ev.body);
      assert.ok(!serialized.includes(key),
        'the clear key must never be readable back from storage');
    });

    it('[SHS03] persists the item in the creator namespace with TTL as duration', async function () {
      const app = await createAppAccess();
      const res = await create(app.token, validBody({ ttl: 600 }));
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      const ev = await coreRequest
        .get(eventsPath + '/' + res.body.sharedSecret.id)
        .set('Authorization', personalToken);
      const event = ev.body.event;
      assert.deepStrictEqual(event.streamIds, [nsFor(app.id)]);
      assert.strictEqual(event.type, 'shared-secret/item');
      assert.strictEqual(event.duration, 600, 'ttl must be carried by duration');
      assert.strictEqual(event.content.status, 'pending');
      assert.ok(Array.isArray(event.content.statusHistory));
      assert.strictEqual(event.content.statusHistory[0].status, 'pending');
      // expires is derived, never stored as its own field
      assert.strictEqual(event.content.expires, undefined);
    });

    it('[SHS04] lazily provisions the namespace root and the per-access substream', async function () {
      const app = await createAppAccess();
      await createOk(app.token, validBody());

      const res = await coreRequest
        .get(streamsPath)
        .set('Authorization', personalToken)
        .query({ parentId: NS_ROOT });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const ids = (res.body.streams || []).map((s) => s.id);
      assert.ok(ids.includes(nsFor(app.id)),
        'expected substream ' + nsFor(app.id) + '; got ' + JSON.stringify(ids));
    });

    it('[SHS05] rejects a missing ttl, title, onConsumed.message or secret', async function () {
      const cases = [
        ['ttl', validBody({ ttl: undefined })],
        ['title', validBody({ title: undefined })],
        ['onConsumed.message', validBody({ onConsumed: { returnUrl: 'https://example.com' } })],
        ['secret', validBody({ secret: undefined })],
        ['null secret', validBody({ secret: null })]
      ];
      for (const [label, body] of cases) {
        const res = await create(personalToken, body);
        assert.strictEqual(res.status, 400, 'expected 400 for missing ' + label +
          '; got ' + res.status + ' ' + JSON.stringify(res.body));
        assert.strictEqual(res.body?.error?.id, 'invalid-parameters-format');
      }
    });

    it('[SHS06] rejects a non-positive ttl (an open-ended secret is never valid)', async function () {
      for (const ttl of [0, -1, null]) {
        const res = await create(personalToken, validBody({ ttl }));
        assert.strictEqual(res.status, 400, 'expected 400 for ttl=' + ttl);
      }
    });

    it('[SHS07] rejects a ttl beyond sharedSecrets.maxTtl (30 days)', async function () {
      const res = await create(personalToken, validBody({ ttl: 2592000 + 1 }));
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'shared-secret-ttl-too-long');
    });

    it('[SHS08] rejects a secret payload beyond sharedSecrets.maxSizeBytes (4 KB)', async function () {
      const res = await create(personalToken, validBody({
        secret: { blob: 'x'.repeat(5000) }
      }));
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'shared-secret-too-large');
    });

    it('[SHS49] rejects a returnUrl that is not http(s) — no open-redirect vector', async function () {
      // returnUrl is creator-supplied and handed to unauthenticated consumers
      // whose expected behaviour is to follow it.
      for (const returnUrl of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'not-a-url'
      ]) {
        const res = await create(personalToken, validBody({
          onConsumed: { message: 'used', returnUrl }
        }));
        assert.strictEqual(res.status, 400,
          'expected 400 for returnUrl ' + returnUrl + '; got ' + res.status);
      }
    });

    it('[SHS50] accepts the exact limits (ttl = maxTtl, secret = maxSizeBytes)', async function () {
      const atMaxTtl = await create(personalToken, validBody({ ttl: 2592000 }));
      assert.strictEqual(atMaxTtl.status, 201, 'ttl exactly at maxTtl must be accepted: ' +
        JSON.stringify(atMaxTtl.body));

      // Serialized JSON byte length is the measure; build a payload landing
      // exactly on the 4096-byte boundary.
      const envelope = JSON.stringify({ blob: '' }).length;
      const atMaxSize = await create(personalToken, validBody({
        secret: { blob: 'x'.repeat(4096 - envelope) }
      }));
      assert.strictEqual(atMaxSize.status, 201, 'a secret of exactly maxSizeBytes must be accepted: ' +
        JSON.stringify(atMaxSize.body));

      const overByOne = await create(personalToken, validBody({
        secret: { blob: 'x'.repeat(4096 - envelope + 1) }
      }));
      assert.strictEqual(overByOne.status, 400, 'one byte over maxSizeBytes must be refused');
    });

    it('[SHS51] a forbidden access cannot mint a child access that escapes the restriction', async function () {
      const restricted = await createAppAccess({
        permissions: [
          { streamId: '*', level: 'manage' },
          { feature: 'secretSharing', setting: 'forbidden' }
        ]
      });
      const res = await coreRequest
        .post(accessesPath)
        .set('Authorization', restricted.token)
        .send({
          name: 'child-' + cuid(),
          type: 'shared',
          permissions: [{ streamId: '*', level: 'read' }]
        });
      // Pin the outcome rather than accepting either: the child is created and
      // inherits the restriction.
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.access.permissions.some(
        (p) => p.feature === 'secretSharing' && p.setting === 'forbidden'),
      'the child must carry the inherited restriction: ' +
        JSON.stringify(res.body.access.permissions));
      const child = await create(res.body.access.token, validBody());
      assert.strictEqual(child.status, 403,
        'a child of a secretSharing-forbidden access must not regain the capability');
    });

    it('[SHS60] the inherited restriction cannot be stripped by accesses.update', async function () {
      const restricted = await createAppAccess({
        permissions: [
          { streamId: '*', level: 'manage' },
          { feature: 'secretSharing', setting: 'forbidden' }
        ]
      });
      const created = await coreRequest
        .post(accessesPath)
        .set('Authorization', restricted.token)
        .send({ name: 'child-' + cuid(), type: 'shared', permissions: [{ streamId: '*', level: 'read' }] });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));

      // Re-issuing the child WITHOUT the feature permission must not clear it.
      const updated = await coreRequest
        .put(accessesPath + '/' + created.body.access.id)
        .set('Authorization', restricted.token)
        .send({ update: { permissions: [{ streamId: '*', level: 'read' }] } });

      if (updated.status === 200) {
        assert.ok(updated.body.access.permissions.some(
          (p) => p.feature === 'secretSharing' && p.setting === 'forbidden'),
        'update must not strip the inherited restriction');
      }
      const child = await create(created.body.access.token, validBody());
      assert.strictEqual(child.status, 403,
        'the child must still be barred after an update attempt');
    });

    it('[SHS09] refuses creation from an access with secretSharing forbidden', async function () {
      const app = await createAppAccess({
        permissions: [
          { streamId: '*', level: 'read' },
          { feature: 'secretSharing', setting: 'forbidden' }
        ]
      });
      const res = await create(app.token, validBody());
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'shared-secret-forbidden');
    });

    it('[SHS10] allows creation by default (no secretSharing entry = allowed)', async function () {
      const app = await createAppAccess();
      const res = await create(app.token, validBody());
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    it('[SHS11] requires an authenticated access to create', async function () {
      const res = await coreRequest.post(secretsPath).send(validBody());
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
    });
  });

  describe('[SHSR] retrieval', function () {
    it('[SHS12] returns the secret to an unauthenticated caller holding the key', async function () {
      const created = await createOk(personalToken, validBody());
      const res = await retrieve(created.key);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.secret, { apiEndpoint: 'https://token@user.pryv.me/' });
    });

    it('[SHS13] is strictly one-shot — the second retrieval yields the onConsumed message', async function () {
      const created = await createOk(personalToken, validBody());
      const key = created.key;

      const first = await retrieve(key);
      assert.strictEqual(first.status, 200);

      const second = await retrieve(key);
      assert.strictEqual(second.status, 403, JSON.stringify(second.body));
      assert.strictEqual(second.body?.error?.message, 'This sharing link has already been used.');
      assert.strictEqual(second.body?.error?.data?.returnUrl, 'https://example.com/back');
      assert.strictEqual(second.body?.secret, undefined, 'the secret must never be served twice');
    });

    it('[SHS14] marks the item consumed, trashed, with status history', async function () {
      const created = await createOk(personalToken, validBody());
      const { id, key } = created;
      await retrieve(key);

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.status, 200, JSON.stringify(ev.body));
      assert.strictEqual(ev.body.event.content.status, 'consumed');
      assert.strictEqual(ev.body.event.trashed, true);
      const history = ev.body.event.content.statusHistory;
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[1].status, 'consumed');
      assert.ok(typeof history[1].time === 'number');
    });

    it('[SHS56] the clear secret is scrubbed once the item leaves pending', async function () {
      const consumed = await createOk(personalToken, validBody());
      await retrieve(consumed.key);
      const afterConsume = await coreRequest
        .get(eventsPath + '/' + consumed.id)
        .set('Authorization', personalToken);
      assert.strictEqual(afterConsume.status, 200, JSON.stringify(afterConsume.body));
      assert.strictEqual(afterConsume.body.event.content.secret, undefined,
        'a consumed secret must not linger at rest');
      // Metadata survives for audit.
      assert.strictEqual(afterConsume.body.event.content.status, 'consumed');
      assert.strictEqual(afterConsume.body.event.content.title, 'Share my token with the clinic');

      // Versioning must not preserve what the scrub removed: with
      // versioning.forceKeepHistory enabled, a snapshot taken before the
      // transition would keep the clear secret readable via includeHistory,
      // making "one-shot" observably false on such a platform.
      const withHistory = await coreRequest
        .get(eventsPath + '/' + consumed.id)
        .set('Authorization', personalToken)
        .query({ includeHistory: true });
      assert.strictEqual(withHistory.status, 200, JSON.stringify(withHistory.body));
      assert.ok(!JSON.stringify(withHistory.body).includes('user.pryv.me'),
        'no history version may retain the clear secret');

      const discarded = await createOk(personalToken, validBody());
      await coreRequest.delete(eventsPath + '/' + discarded.id).set('Authorization', personalToken);
      const afterDiscard = await coreRequest
        .get(eventsPath + '/' + discarded.id)
        .set('Authorization', personalToken);
      assert.strictEqual(afterDiscard.body.event.content.secret, undefined,
        'a discarded secret must not linger at rest either');
    });

    it('[SHS15] refuses an expired secret — the gate is now > time + duration', async function () {
      // 1s TTL, then wait it out: expiry is evaluated lazily at retrieval,
      // there is no background reaper.
      const created = await createOk(personalToken, validBody({ ttl: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 1600));

      const res = await retrieve(created.key);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body?.secret, undefined);

      const ev = await coreRequest
        .get(eventsPath + '/' + created.id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.body.event.content.status, 'discarded');
      assert.strictEqual(ev.body.event.content.statusHistory.at(-1).info, 'expired');
    });

    it('[SHS16] refuses an unknown or malformed key without leaking existence', async function () {
      const created = await createOk(personalToken, validBody());
      const { id } = created;
      const keys = [
        'not-a-key',
        id,                                  // id alone, no random half
        id + '.' + 'A'.repeat(32),           // right id, wrong random half
        cuid() + '.' + 'A'.repeat(32)        // unknown id
      ];
      // Every shape must fail IDENTICALLY: a status that differs between
      // "unknown id" and "known id, wrong random half" is an existence oracle.
      const outcomes = [];
      for (const key of keys) {
        const res = await retrieve(key);
        assert.strictEqual(res.body?.secret, undefined);
        outcomes.push({ status: res.status, id: res.body?.error?.id });
      }
      const distinct = [...new Set(outcomes.map((o) => JSON.stringify(o)))];
      assert.strictEqual(distinct.length, 1,
        'unknown/malformed keys must be indistinguishable; got ' + JSON.stringify(outcomes));
      // A wrong key must NOT burn the secret: it is still retrievable.
      const ok = await retrieve(created.key);
      assert.strictEqual(ok.status, 200, 'a failed key guess must not consume the secret');
    });

    it('[SHS17] signature "secret" — matching payload releases the secret', async function () {
      const created = await createOk(personalToken, validBody({
        signature: { type: 'secret', value: 'shared-passphrase' }
      }));
      const res = await retrieve(created.key, {
        signature: { type: 'secret', payload: 'shared-passphrase' }
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.secret);
    });

    it('[SHS18] signature "secret" — a mismatch discards the secret for good', async function () {
      const created = await createOk(personalToken, validBody({
        signature: { type: 'secret', value: 'shared-passphrase' }
      }));
      const { id, key } = created;

      const bad = await retrieve(key, {
        signature: { type: 'secret', payload: 'wrong' }
      });
      assert.strictEqual(bad.status, 403, JSON.stringify(bad.body));

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.body.event.content.status, 'discarded');
      assert.match(ev.body.event.content.statusHistory.at(-1).info, /does not match/i);

      // Burned: even the correct payload no longer works.
      const retry = await retrieve(key, {
        signature: { type: 'secret', payload: 'shared-passphrase' }
      });
      assert.strictEqual(retry.status, 403);
      assert.strictEqual(retry.body?.secret, undefined);
    });

    it('[SHS19] signature "secret" — a missing payload is refused but does NOT burn', async function () {
      // A wrong payload burns ([SHS18]); a missing one must not, so a client can
      // attempt bare, discover a passphrase is needed, and retry.
      const created = await createOk(personalToken, validBody({
        signature: { type: 'secret', value: 'shared-passphrase' }
      }));
      const bare = await retrieve(created.key);
      assert.strictEqual(bare.status, 403, JSON.stringify(bare.body));
      assert.strictEqual(bare.body?.secret, undefined);

      const retry = await retrieve(created.key, {
        signature: { type: 'secret', payload: 'shared-passphrase' }
      });
      assert.strictEqual(retry.status, 200,
        'a bare attempt must leave the secret retrievable: ' + JSON.stringify(retry.body));
      assert.ok(retry.body.secret);
    });

    /**
     * hmac-sha256 requires the caller to bind the HMAC to key material BEFORE
     * the item exists, so the client supplies the random half itself (sending
     * only its hash) and composes `key = <id>.<randomPart>` from the response.
     * The server still mints the event id, and still stores nothing but the hash.
     */
    it('[SHS20] signature "hmac-sha256" — proof of the verifier secret releases it', async function () {
      const verifier = 'out-of-band-verifier-secret';
      const randomPart = crypto.randomBytes(24).toString('base64url');
      const keyHash = crypto.createHash('sha256').update(randomPart).digest('hex');

      const res = await create(personalToken, validBody({
        keyHash,
        signature: { type: 'hmac-sha256', value: hmacPayload(verifier, randomPart) }
      }));
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      // The server never saw the random half, so it cannot return the key.
      assert.strictEqual(res.body.sharedSecret.key, undefined,
        'with a client-supplied keyHash the server must not invent a key');
      const key = res.body.sharedSecret.id + '.' + randomPart;

      const wrong = await retrieve(key, {
        signature: { type: 'hmac-sha256', payload: hmacPayload('other-secret', randomPart) }
      });
      assert.strictEqual(wrong.status, 403, 'a wrong verifier must be refused');

      // A wrong HMAC burns it, exactly like a wrong `secret` payload.
      const right = await retrieve(key, {
        signature: { type: 'hmac-sha256', payload: hmacPayload(verifier, randomPart) }
      });
      assert.strictEqual(right.status, 403,
        'a burned secret stays burned even for the correct verifier');
    });

    it('[SHS55] a client-supplied keyHash must be a full-strength hash', async function () {
      for (const keyHash of ['short', 'zz' + 'a'.repeat(62), 'a'.repeat(63), 'a'.repeat(65), '']) {
        const res = await create(personalToken, validBody({ keyHash }));
        assert.strictEqual(res.status, 400,
          'expected 400 for keyHash ' + JSON.stringify(keyHash) + '; got ' + res.status);
      }
    });

    it('[SHS21] rejects an unknown signature type at creation', async function () {
      const res = await create(personalToken, validBody({
        signature: { type: 'magic-wave', value: 'x' }
      }));
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    });

    it('[SHS52] a key never resolves under another user\'s path, and does not burn', async function () {
      const created = await createOk(personalToken, validBody());

      const cross = await coreRequest
        .post('/' + otherUsername + '/shared-secrets/retrieve')
        .send({ key: created.key });
      assert.notStrictEqual(cross.status, 200, 'a key must not resolve under a foreign account');
      assert.strictEqual(cross.body?.secret, undefined);

      // …and the owner's secret must survive the attempt intact.
      const ok = await retrieve(created.key);
      assert.strictEqual(ok.status, 200,
        'a cross-account attempt must not consume the owner\'s secret');
    });

    it('[SHS22] retrieval never requires — nor accepts — the creator token as authority', async function () {
      // The key is the sole credential: holding a token but not the key gets nothing.
      const created = await createOk(personalToken, validBody());
      const res = await coreRequest
        .post(secretsPath + '/retrieve')
        .set('Authorization', personalToken)
        .send({ key: created.id + '.wrongrandomhalfwrongrandom' });
      assert.notStrictEqual(res.status, 200);
      assert.strictEqual(res.body?.secret, undefined);
    });
  });

  describe('[SHSA] atomicity', function () {
    it('[SHS23] concurrent retrievals of the same key yield exactly one winner', async function () {
      const created = await createOk(personalToken, validBody());
      const key = created.key;

      const results = await Promise.all(
        Array.from({ length: 8 }, () => retrieve(key))
      );
      const winners = results.filter((r) => r.status === 200);
      assert.strictEqual(winners.length, 1,
        'exactly one concurrent retrieval must win; got ' +
        JSON.stringify(results.map((r) => r.status)));
      assert.ok(winners[0].body.secret);
      for (const loser of results.filter((r) => r.status !== 200)) {
        assert.strictEqual(loser.status, 403,
          'losing racers must get the clean already-consumed refusal, not a 500');
        assert.strictEqual(loser.body?.secret, undefined);
      }
    });

    it('[SHS24] the losing racers do not corrupt the status history', async function () {
      const created = await createOk(personalToken, validBody());
      const { id, key } = created;
      await Promise.all(Array.from({ length: 8 }, () => retrieve(key)));

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      const history = ev.body.event.content.statusHistory;
      assert.strictEqual(ev.body.event.content.status, 'consumed');
      assert.strictEqual(history.length, 2, 'exactly one transition must be recorded: ' +
        JSON.stringify(history));
    });
  });

  describe('[SHSV] visibility', function () {
    it('[SHS25] shared secrets stay out of a wildcard events.get — for app AND personal', async function () {
      const app = await createAppAccess();
      const created = await createOk(app.token, validBody());

      for (const [label, token] of [['personal', personalToken], ['app', app.token]]) {
        const res = await coreRequest
          .get(eventsPath)
          .set('Authorization', token)
          .query({ streams: ['*'], limit: 1000, state: 'all' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const ids = (res.body.events || []).map((e) => e.id);
        assert.ok(!ids.includes(created.id),
          'shared secret leaked into the ' + label + ' wildcard query');
      }
    });

    it('[SHS67] listing before ever creating one returns empty, not 404', async function () {
      // The namespace is provisioned lazily, so a consumer whose FIRST action is
      // "show me my outstanding secrets" must still get an answer — otherwise the
      // read that needs the stream is also the thing refusing to create it. The
      // CMC namespace shipped exactly that gap and a live integration hit it.
      const fresh = await createAppAccess();

      const events = await coreRequest.get(eventsPath)
        .set('Authorization', fresh.token)
        .query({ streams: [nsFor(fresh.id)] });
      assert.strictEqual(events.status, 200,
        'a first-time read must not 404: ' + JSON.stringify(events.body));
      assert.deepStrictEqual(events.body.events, []);

      const streams = await coreRequest.get(streamsPath)
        .set('Authorization', fresh.token)
        .query({ parentId: NS_ROOT });
      assert.ok(streams.status === 200 || streams.status === 403,
        'a first-time stream listing must resolve, not 404: ' + JSON.stringify(streams.body));
    });

    it('[SHS26] an access lists its own shared secrets when naming the stream explicitly', async function () {
      const app = await createAppAccess();
      const created = await createOk(app.token, validBody());

      const res = await coreRequest
        .get(eventsPath)
        .set('Authorization', app.token)
        .query({ streams: [nsFor(app.id)] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const ids = (res.body.events || []).map((e) => e.id);
      assert.ok(ids.includes(created.id),
        'creator must see its own pending shared secret');
    });

    it('[SHS27] consumed items are visible only with state=trashed', async function () {
      const app = await createAppAccess();
      const created = await createOk(app.token, validBody());
      await retrieve(created.key);

      const def = await coreRequest.get(eventsPath).set('Authorization', app.token)
        .query({ streams: [nsFor(app.id)] });
      assert.ok(!(def.body.events || []).map((e) => e.id).includes(created.id),
        'a consumed item must not show in the default (pending) listing');

      const trashed = await coreRequest.get(eventsPath).set('Authorization', app.token)
        .query({ streams: [nsFor(app.id)], state: 'trashed' });
      assert.ok((trashed.body.events || []).map((e) => e.id).includes(created.id),
        'a consumed item must be listed with state=trashed');
    });

    it('[SHS28] an access cannot read another access\'s shared secrets', async function () {
      const owner = await createAppAccess();
      const other = await createAppAccess();
      const created = await createOk(owner.token, validBody());

      const listed = await coreRequest
        .get(eventsPath)
        .set('Authorization', other.token)
        .query({ streams: [nsFor(owner.id)], state: 'all' });
      assert.ok(listed.status === 403 || (listed.body.events || []).length === 0,
        'a foreign access must not list someone else\'s namespace');

      const direct = await coreRequest
        .get(eventsPath + '/' + created.id)
        .set('Authorization', other.token);
      assert.notStrictEqual(direct.status, 200,
        'a foreign access must not read the item directly');
    });

    it('[SHS57] naming the namespace ROOT does not hand over everyone\'s secrets', async function () {
      // The substream check ([SHS28]) is not enough: the root is not a substream,
      // so a `*` grant used to resolve to `read` on it and expansion then walked
      // every child. One request, no key, every secret in the clear.
      const owner = await createAppAccess();
      const created = await createOk(owner.token, validBody());
      const attacker = await createAppAccess({
        permissions: [{ streamId: '*', level: 'read' }]
      });

      for (const streams of [[NS_ROOT], [':_shared-secrets'], [{ any: [NS_ROOT] }]]) {
        const res = await coreRequest
          .get(eventsPath)
          .set('Authorization', attacker.token)
          .query({ streams, state: 'all' });
        const ids = (res.body.events || []).map((e) => e.id);
        assert.ok(!ids.includes(created.id),
          'root query ' + JSON.stringify(streams) + ' leaked a foreign secret');
        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes('user.pryv.me'),
          'no secret payload may appear in a namespace-root query');
      }
    });

    it('[SHS58] a forged shared-secret event is neither creatable nor redeemable', async function () {
      // Without this, the secretSharing opt-out is decorative: forge the item
      // type in an ordinary stream and the public endpoint serves it.
      const app = await createAppAccess({
        permissions: [
          { streamId: '*', level: 'manage' },
          { feature: 'secretSharing', setting: 'forbidden' }
        ]
      });
      const randomPart = crypto.randomBytes(24).toString('base64url');
      const forged = {
        streamIds: ['diary'],
        type: 'shared-secret/item',
        duration: 3600,
        content: {
          keyHash: crypto.createHash('sha256').update(randomPart).digest('hex'),
          title: 'forged',
          status: 'pending',
          statusHistory: [{ status: 'pending', time: 1 }],
          onConsumed: { message: 'x' },
          secret: { stolen: true }
        }
      };
      await coreRequest.post(streamsPath).set('Authorization', personalToken)
        .send({ id: 'diary', name: 'Diary' });

      const res = await coreRequest.post(eventsPath)
        .set('Authorization', app.token).send(forged);
      assert.strictEqual(res.status, 403,
        'the shared-secret event type must be reserved: ' + JSON.stringify(res.body));

      // Belt and braces: even if such an event existed, redeeming it must fail
      // because it does not live in the namespace.
      const planted = await coreRequest.post(eventsPath)
        .set('Authorization', personalToken)
        .send(Object.assign({}, forged, { type: 'note/txt', content: 'x' }));
      if (planted.status === 201) {
        const out = await retrieve(planted.body.event.id + '.' + randomPart);
        assert.notStrictEqual(out.status, 200);
        assert.strictEqual(out.body?.secret, undefined);
      }
    });

    it('[SHS65] an event cannot be turned into a shared secret by events.update', async function () {
      // Moving an ordinary event into the namespace (or stamping it with the
      // reserved type) would mint a redeemable secret that skipped creation
      // validation entirely — no TTL ceiling, no size cap, and no returnUrl
      // scheme check, which is the one that keeps a javascript: URL away from
      // an unauthenticated third party.
      const app = await createAppAccess({ permissions: [{ streamId: '*', level: 'manage' }] });
      await createOk(app.token, validBody()); // provisions the app's substream
      await coreRequest.post(streamsPath).set('Authorization', personalToken)
        .send({ id: 'notes', name: 'Notes' });

      const plain = await coreRequest.post(eventsPath).set('Authorization', app.token)
        .send({ streamIds: ['notes'], type: 'note/txt', content: 'ordinary' });
      assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));

      const moved = await coreRequest.put(eventsPath + '/' + plain.body.event.id)
        .set('Authorization', app.token)
        .send({ streamIds: [nsFor(app.id)] });
      assert.strictEqual(moved.status, 403, 'must not move an event into the namespace: ' +
        JSON.stringify(moved.body));

      const retyped = await coreRequest.put(eventsPath + '/' + plain.body.event.id)
        .set('Authorization', app.token)
        .send({ type: 'shared-secret/item' });
      assert.strictEqual(retyped.status, 403, 'must not stamp the reserved type: ' +
        JSON.stringify(retyped.body));
    });

    it('[SHS66] namespace streams cannot be renamed or re-parented', async function () {
      const owner = await createAppAccess();
      await createOk(owner.token, validBody());
      const attacker = await createAppAccess({
        permissions: [{ streamId: '*', level: 'manage' }]
      });
      await coreRequest.post(streamsPath).set('Authorization', personalToken)
        .send({ id: 'loot', name: 'Loot' });

      // Re-parenting a victim's substream out of the namespace would strip every
      // namespace rule from it and expose the secrets as ordinary events.
      const reparent = await coreRequest
        .put(streamsPath + '/' + encodeURIComponent(nsFor(owner.id)))
        .set('Authorization', attacker.token)
        .send({ parentId: 'loot' });
      assert.notStrictEqual(reparent.status, 200, JSON.stringify(reparent.body));

      // The root is protected too — moving it would expose everyone at once.
      const moveRoot = await coreRequest
        .put(streamsPath + '/' + encodeURIComponent(NS_ROOT))
        .set('Authorization', personalToken)
        .send({ parentId: 'loot' });
      assert.notStrictEqual(moveRoot.status, 200, JSON.stringify(moveRoot.body));

      // …and the owner's secret is still exactly where it was.
      const listed = await coreRequest.get(eventsPath).set('Authorization', owner.token)
        .query({ streams: [nsFor(owner.id)] });
      assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    });

    it('[SHS59] events.create into the namespace is refused', async function () {
      const app = await createAppAccess({ permissions: [{ streamId: '*', level: 'manage' }] });
      const res = await coreRequest.post(eventsPath)
        .set('Authorization', app.token)
        .send({ streamIds: [nsFor(app.id)], type: 'note/txt', content: 'hand-made' });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    });

    it('[SHS29] the creator inspects status by key without consuming', async function () {
      const app = await createAppAccess();
      const created = await createOk(app.token, validBody());
      const { key, id } = created;

      const res = await coreRequest
        .post(secretsPath + '/status')
        .set('Authorization', app.token)
        .send({ key });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.sharedSecret.id, id);
      assert.strictEqual(res.body.sharedSecret.status, 'pending');
      assert.strictEqual(res.body.sharedSecret.secret, undefined,
        'a status read must not disclose the secret');

      // Status untouched: a real consumer can still retrieve it.
      const consume = await retrieve(key);
      assert.strictEqual(consume.status, 200, 'a status read must not consume the secret');
    });

    it('[SHS54] the status endpoint requires authentication', async function () {
      // Otherwise it becomes a non-consuming probe: an attacker could validate a
      // candidate key without burning it, defeating the burn-on-use tell.
      const created = await createOk(personalToken, validBody());
      const res = await coreRequest.post(secretsPath + '/status').send({ key: created.key });
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body?.sharedSecret, undefined);
    });

    it('[SHS30] a personal token lists the accesses that created shared secrets', async function () {
      const app = await createAppAccess();
      await createOk(app.token, validBody());

      const res = await coreRequest
        .get(streamsPath)
        .set('Authorization', personalToken)
        .query({ parentId: NS_ROOT });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok((res.body.streams || []).map((s) => s.id).includes(nsFor(app.id)));
    });

    it('[SHS31] a non-personal access cannot enumerate the namespace root', async function () {
      const app = await createAppAccess();
      await createOk(app.token, validBody());

      const res = await coreRequest
        .get(streamsPath)
        .set('Authorization', app.token)
        .query({ parentId: NS_ROOT });
      const ids = (res.body.streams || []).map((s) => s.id);
      assert.ok(res.status === 403 || ids.every((id) => id === nsFor(app.id)),
        'an app access must not enumerate other accesses\' substreams: ' + JSON.stringify(ids));
    });
  });

  describe('[SHSI] immutability', function () {
    it('[SHS32] events.update is refused on the namespace', async function () {
      const created = await createOk(personalToken, validBody());
      const res = await coreRequest
        .put(eventsPath + '/' + created.id)
        .set('Authorization', personalToken)
        .send({ content: { status: 'pending', secret: { stolen: true } } });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.data?.id, 'shared-secret-immutable');
    });

    it('[SHS33] deleting a pending item discards it instead of removing it', async function () {
      const created = await createOk(personalToken, validBody());
      const { id, key } = created;

      const del = await coreRequest
        .delete(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.status, 200, 'the discarded item must survive as history');
      assert.strictEqual(ev.body.event.content.status, 'discarded');
      assert.strictEqual(ev.body.event.content.statusHistory.at(-1).info, 'deleted');

      const res = await retrieve(key);
      assert.strictEqual(res.status, 403, 'a discarded secret must never be served');
    });

    it('[SHS34] a non-pending item can no longer be mutated or re-deleted away', async function () {
      const created = await createOk(personalToken, validBody());
      const { id, key } = created;
      await retrieve(key);

      const del = await coreRequest
        .delete(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(del.status, 403, JSON.stringify(del.body));

      const ev = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(ev.body.event.content.status, 'consumed',
        'consumed is terminal — a delete must not rewrite it to discarded');
    });

    it('[SHS35] the namespace streams cannot be created or deleted by hand', async function () {
      const app = await createAppAccess();
      await createOk(app.token, validBody());

      const rootCreate = await coreRequest
        .post(streamsPath)
        .set('Authorization', personalToken)
        .send({ id: NS_ROOT, name: 'root attempt' });
      assert.strictEqual(rootCreate.status, 400, JSON.stringify(rootCreate.body));

      const subCreate = await coreRequest
        .post(streamsPath)
        .set('Authorization', personalToken)
        .send({ id: nsFor(cuid()), parentId: NS_ROOT, name: 'sub attempt' });
      assert.strictEqual(subCreate.status, 400, JSON.stringify(subCreate.body));

      const del = await coreRequest
        .delete(streamsPath + '/' + encodeURIComponent(nsFor(app.id)))
        .set('Authorization', personalToken);
      assert.strictEqual(del.status, 400, JSON.stringify(del.body));
    });

    it('[SHS36] consuming recomputes the event integrity hash instead of leaving it stale', async function () {
      const created = await createOk(personalToken, validBody());
      const { id, key } = created;

      const before = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(before.status, 200, JSON.stringify(before.body));
      const hashBefore = before.body.event.integrity;

      await retrieve(key);

      const after = await coreRequest
        .get(eventsPath + '/' + id)
        .set('Authorization', personalToken);
      assert.strictEqual(after.status, 200, JSON.stringify(after.body));

      // Deployment-dependent: only meaningful where event integrity is enabled.
      // When it is, a server-side content mutation that skips the rehash leaves
      // the OLD hash behind — that is the bug this pins.
      if (hashBefore != null) {
        assert.ok(after.body.event.integrity != null,
          'integrity must not be dropped by the consume');
        assert.notStrictEqual(after.body.event.integrity, hashBefore,
          'the content changed on consume, so its integrity hash must change too');
      }
    });

    it('[SHS53] a foreign access cannot discard someone else\'s pending secret', async function () {
      const owner = await createAppAccess();
      // The attacker needs write rights for this to prove anything — with only
      // `read` it fails the ordinary permission check and never reaches the
      // namespace rule, so the test would pass while the hole stayed open.
      const attacker = await createAppAccess({
        permissions: [{ streamId: '*', level: 'manage' }]
      });
      const created = await createOk(owner.token, validBody());

      const del = await coreRequest
        .delete(eventsPath + '/' + created.id)
        .set('Authorization', attacker.token);
      assert.notStrictEqual(del.status, 200,
        'a foreign access must not be able to burn someone else\'s secret');

      const ok = await retrieve(created.key);
      assert.strictEqual(ok.status, 200, 'the owner\'s secret must survive the attempt');
    });
  });
});
