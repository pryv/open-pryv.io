/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const accessState = require('../src/routes/reg/accessState.ts');
const { withInjectedConfig } = require('test-helpers');

describe('[RGAC] Register access authorization', () => {
  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
  });

  afterEach(async () => {
    await accessState.clear();
  });

  describe('POST /reg/access', () => {
    it('[RA01] must create an access request and return polling key', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, 'NEED_SIGNIN');
      assert.ok(res.body.key);
      assert.strictEqual(res.body.key.length, 16);
      assert.ok(res.body.poll);
      assert.strictEqual(res.body.poll_rate_ms, 1000);
    });

    it('[RA02] must return 400 for missing requestingAppId', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ requestedPermissions: [{ streamId: 'diary', level: 'read' }] });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RA03] must return 400 for missing requestedPermissions', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
    });

    it('[RA04] must echo clientData and oauthState on GET (NEED_SIGNIN poll)', async () => {
      const postRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }],
          clientData: { foo: 'bar' },
          oauthState: 'xyz123'
        });
      assert.strictEqual(postRes.status, 201);
      // POST response is trimmed to the calling-app surface; clientData /
      // oauthState live on the GET (auth UI consumer).
      const getRes = await coreRequest.get('/reg/access/' + postRes.body.key);
      assert.strictEqual(getRes.status, 201);
      assert.deepStrictEqual(getRes.body.clientData, { foo: 'bar' });
      assert.strictEqual(getRes.body.oauthState, 'xyz123');
    });
  });

  describe('[RACP] POST /reg/access ceiling on live requests (access:maxLiveRequests)', () => {
    function createRequest () {
      return coreRequest.post('/reg/access')
        .send({ requestingAppId: 'cap-app', requestedPermissions: [{ streamId: 'diary', level: 'read' }] });
    }

    it('[RAC1] refuses with 429 once the core holds the configured number of live requests', async () => {
      await withInjectedConfig({ access: { maxLiveRequests: 2 } }, async () => {
        assert.strictEqual((await createRequest()).status, 201);
        assert.strictEqual((await createRequest()).status, 201);
        const refused = await createRequest();
        assert.strictEqual(refused.status, 429);
        assert.strictEqual(refused.body.error.id, 'too-many-requests');
        // The refusal says nothing about the ceiling or how close the caller got.
        assert.ok(!/\b2\b/.test(refused.body.error.message), 'message must not leak the ceiling');
      });
    });

    it('[RAC2] a freed slot lets the next request through', async () => {
      await withInjectedConfig({ access: { maxLiveRequests: 1 } }, async () => {
        const first = await createRequest();
        assert.strictEqual(first.status, 201);
        assert.strictEqual((await createRequest()).status, 429);
        await accessState.remove(first.body.key);
        assert.strictEqual((await createRequest()).status, 201);
      });
    });

    it('[RAC3] 0 disables the ceiling', async () => {
      await withInjectedConfig({ access: { maxLiveRequests: 0 } }, async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await createRequest()).status, 201);
      });
    });
  });

  describe('POST /reg/access with client-supplied authUrl (access:trustedAuthUrls)', () => {
    // Config mutation goes through withInjectedConfig (snapshot + restore) —
    // raw config.set() in matrix mode poisons later injectTestConfig resets.
    const { withInjectedConfig } = require('test-helpers');
    const TRUSTED = { access: { trustedAuthUrls: ['https://auth.example.com/my-auth/'] } };
    const BODY = {
      requestingAppId: 'test-app',
      requestedPermissions: [{ streamId: 'diary', level: 'read' }]
    };

    it('[RA50] must use a client authUrl that matches a trusted entry', async () => {
      await withInjectedConfig(TRUSTED, async () => {
        const res = await coreRequest.post('/reg/access')
          .send({ ...BODY, authUrl: 'https://auth.example.com/my-auth/custom.html' });
        assert.strictEqual(res.status, 201);
        assert.ok(res.body.authUrl.startsWith('https://auth.example.com/my-auth/custom.html?'),
          `authUrl should start with the client page, got: ${res.body.authUrl}`);
        // flow params are appended exactly as for the default auth page
        assert.ok(res.body.authUrl.includes('key=' + res.body.key));
        assert.ok(res.body.authUrl.includes('poll='));
      });
    });

    it('[RA51] must reject an authUrl not covered by trustedAuthUrls', async () => {
      await withInjectedConfig(TRUSTED, async () => {
        const res = await coreRequest.post('/reg/access')
          .send({ ...BODY, authUrl: 'https://evil.example.net/my-auth/custom.html' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.id, 'invalid-parameters');
        assert.ok(res.body.error.message.includes('trustedAuthUrls'));
      });
    });

    it('[RA52] must reject any authUrl when no trustedAuthUrls are configured', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ ...BODY, authUrl: 'https://auth.example.com/my-auth/custom.html' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.ok(res.body.error.message.includes('none configured'));
    });

    it('[RA53] must not be fooled by host-suffix or path-prefix tricks', async () => {
      await withInjectedConfig({ access: { trustedAuthUrls: ['https://auth.example.com/my-auth'] } }, async () => {
        for (const sneaky of [
          'https://auth.example.com.evil.net/my-auth/x.html', // host suffix
          'https://auth.example.com/my-auth-evil/x.html', // path segment prefix
          'http://auth.example.com/my-auth/x.html', // protocol downgrade
          'https://user:pass@auth.example.com/my-auth/x.html', // credentials
          'not-a-url'
        ]) {
          const res = await coreRequest.post('/reg/access').send({ ...BODY, authUrl: sneaky });
          assert.strictEqual(res.status, 400, `expected 400 for ${sneaky}`);
        }
      });
    });

    it('[RA54] default flow stays unchanged when no authUrl is sent, even with trustedAuthUrls configured', async () => {
      await withInjectedConfig(TRUSTED, async () => {
        const res = await coreRequest.post('/reg/access').send(BODY);
        assert.strictEqual(res.status, 201);
        // default-config test setup has no access:defaultAuthUrl → authUrl null
        // (or the configured default when one is set — either way NOT the trusted entry)
        if (res.body.authUrl != null) {
          assert.ok(!res.body.authUrl.startsWith('https://auth.example.com/'));
        }
      });
    });
  });

  describe('POST /reg/access with a consent sidecar', () => {
    const PERMS = [
      { streamId: 'diary', level: 'read', defaultName: 'Journal' },
      { streamId: 'weight', level: 'read' },
      { feature: 'selfRevoke', setting: 'forbidden' }
    ];

    it('[RA60] must resolve the sidecar, echo the consent form on create and on the poll', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: PERMS,
          consent: { allowUserChoice: true, mandatory: ['diary'], optIn: ['weight'] }
        });
      assert.strictEqual(createRes.status, 201);
      const expectedForm = {
        allowUserChoice: true,
        permissions: [
          { streamId: 'diary', level: 'read', defaultName: 'Journal', mandatory: true },
          { streamId: 'weight', level: 'read', optIn: true },
          { feature: 'selfRevoke', setting: 'forbidden' }
        ]
      };
      // Echoed on create: this is how an app detects that the server
      // understood the annotations (an older one echoes nothing).
      assert.deepEqual(createRes.body.consent, expectedForm);

      const pollRes = await coreRequest.get('/reg/access/' + createRes.body.key);
      assert.strictEqual(pollRes.status, 201);
      assert.deepEqual(pollRes.body.consent, expectedForm);
      // The plain entries are untouched: an auth page that ignores
      // `consent` still receives exactly what it always received.
      assert.deepEqual(pollRes.body.requestedPermissions, PERMS);
    });

    it('[RA61] without a sidecar the create and poll bodies carry no consent key at all', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app', requestedPermissions: PERMS });
      assert.strictEqual(createRes.status, 201);
      // Absent, not null: an un-annotated request must be byte-identical
      // to what it was before consent forms existed.
      assert.ok(!('consent' in createRes.body), 'create body must not carry a consent key');

      const pollRes = await coreRequest.get('/reg/access/' + createRes.body.key);
      assert.strictEqual(pollRes.status, 201);
      assert.ok(!('consent' in pollRes.body), 'poll body must not carry a consent key');
      assert.deepEqual(pollRes.body.requestedPermissions, PERMS);
    });

    it('[RA62] must reject a sidecar that names nothing, names twice, or is mistyped', async () => {
      const cases = [
        { consent: { mandatory: ['diarry'] }, why: 'unknown id' },
        { consent: { mandatory: ['diary'], optIn: ['diary'] }, why: 'id in both lists' },
        { consent: { allowUserChoice: 'yes' }, why: 'non-boolean allowUserChoice' },
        { consent: { mandatory: 'diary' }, why: 'id list not an array' },
        {
          permissions: [{ streamId: 'diary', level: 'read' }, { streamId: 'diary', level: 'contribute' }],
          consent: { mandatory: ['diary'] },
          why: 'ambiguous id (two entries share it)'
        }
      ];
      for (const c of cases) {
        const res = await coreRequest.post('/reg/access')
          .send({
            requestingAppId: 'test-app',
            requestedPermissions: c.permissions || PERMS,
            consent: c.consent
          });
        assert.strictEqual(res.status, 400, c.why);
        assert.strictEqual(res.body.error.id, 'invalid-parameters', c.why);
      }
    });

    it('[RA63] must reject an exclusion mask (level:none) once a consent form is asked for', async () => {
      // Dropping a `none` entry at the consent screen would WIDEN access,
      // inverting the subset rule, so an annotated request may not carry one.
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: '*', level: 'read' }, { streamId: 'medical', level: 'none' }],
          consent: { allowUserChoice: true }
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      // ... while the same request without a sidecar is still accepted.
      const plainRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: '*', level: 'read' }, { streamId: 'medical', level: 'none' }]
        });
      assert.strictEqual(plainRes.status, 201);
    });

    it('[RA64] mandatory without allowUserChoice is accepted and echoed (inert, as in a CMC offer)', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: PERMS,
          consent: { mandatory: ['diary'] }
        });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.consent.allowUserChoice, false);
      assert.strictEqual(res.body.consent.permissions[0].mandatory, true);
    });
  });

  describe('GET /reg/access/:key', () => {
    it('[RA10] must return current state for valid key', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.status, 'NEED_SIGNIN');
      assert.strictEqual(res.body.requestingAppId, 'test-app');
    });

    it('[RA11] must return 400 for unknown key', async () => {
      const res = await coreRequest.get('/reg/access/nonexistentkey00');
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'unknown-access-key');
    });
  });

  describe('POST /reg/access/:key (accept)', () => {
    it('[RA20] must accept and return token + apiEndpoint', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const acceptRes = await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'ACCEPTED',
          username: 'testuser',
          token: 'abc123token',
          apiEndpoint: 'https://testuser.pryv.me/'
        });
      assert.strictEqual(acceptRes.status, 200);
      assert.strictEqual(acceptRes.body.status, 'ACCEPTED');
      assert.strictEqual(acceptRes.body.username, 'testuser');
      assert.strictEqual(acceptRes.body.token, 'abc123token');
      assert.strictEqual(acceptRes.body.apiEndpoint, 'https://testuser.pryv.me/');
    });

    it('[RA21] subsequent poll must return ACCEPTED state', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'ACCEPTED',
          username: 'testuser',
          token: 'abc123token',
          apiEndpoint: 'https://testuser.pryv.me/'
        });

      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.status, 200);
      assert.strictEqual(pollRes.body.status, 'ACCEPTED');
      assert.strictEqual(pollRes.body.token, 'abc123token');
    });

    it('[RA22] must return 400 for ACCEPTED without token', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username: 'testuser' });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('POST /reg/access/:key (accept) with a consent form', () => {
    // These exercise the real check: a real user, real app accesses minted
    // in storage, and the server reading the access behind the posted token
    // through the same loader `access-info` runs.
    let fixtures, fixtureUser, username;
    let counter = 0;

    const OFFER = [
      { streamId: 'diary', level: 'read', defaultName: 'Journal' },
      { streamId: 'weight', level: 'read' }
    ];
    // diary is required, weight is offered unticked, the user may choose.
    const SIDECAR = { allowUserChoice: true, mandatory: ['diary'], optIn: ['weight'] };

    before(async function () {
      this.timeout(30000);
      fixtures = getNewFixture();
      username = cuid();
      fixtureUser = await fixtures.user(username);
      await fixtureUser.stream({ id: 'diary', name: 'Journal' });
      await fixtureUser.stream({ id: 'weight', name: 'Weight' });
      await fixtureUser.stream({ id: 'secret', name: 'Secret' });
    });

    after(async function () {
      this.timeout(30000);
      // Remove the user this block created: a later suite that resets users
      // (reg-multicore) would otherwise leave its platform entries behind.
      await fixtures.clean();
    });

    /** Mint an app access the way an auth page would, and return its token.
     * The name varies per mint because (name, type, deviceName) is unique
     * per user; what the check reads is the permissions, not the name. */
    async function mintApp (permissions) {
      const n = ++counter;
      const token = 'tok-' + n + '-' + cuid();
      await fixtureUser.access({
        id: 'acc-' + n + '-' + cuid(),
        type: 'app',
        name: 'test-app-' + n,
        token,
        permissions
      });
      return token;
    }

    async function createRequest (consent) {
      const res = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: OFFER,
          ...(consent !== undefined ? { consent } : {})
        });
      assert.strictEqual(res.status, 201);
      return res.body.key;
    }

    function accept (key, token) {
      return coreRequest.post('/reg/access/' + key).send({
        status: 'ACCEPTED',
        username,
        token,
        apiEndpoint: 'https://' + username + '.pryv.me/'
      });
    }

    it('[RA70] must accept an access carrying the whole offer (the old-page path)', async () => {
      const key = await createRequest(SIDECAR);
      const token = await mintApp([
        { streamId: 'diary', level: 'read' },
        { streamId: 'weight', level: 'read' }
      ]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ACCEPTED');
    });

    it('[RA71] must accept a subset that drops an opt-in entry, and hand the token back', async () => {
      const key = await createRequest(SIDECAR);
      const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.body.status, 'ACCEPTED');
      assert.strictEqual(pollRes.body.token, token);
    });

    it('[RA72] must refuse a grant missing a mandatory entry, leave the state open, and accept a corrected retry', async () => {
      const key = await createRequest(SIDECAR);
      const badToken = await mintApp([{ streamId: 'weight', level: 'read' }]); // drops mandatory diary
      const res = await accept(key, badToken);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-consent-grant');
      assert.strictEqual(res.body.error.data.reason, 'mandatory-refused');
      // The offending entries come from the OFFER, so they carry its
      // display name; only the consent annotations are stripped.
      assert.deepEqual(res.body.error.data.offending,
        [{ streamId: 'diary', level: 'read', defaultName: 'Journal' }]);

      // The request is untouched, so the page can fix the grant and retry.
      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.body.status, 'NEED_SIGNIN');

      const goodToken = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const retryRes = await accept(key, goodToken);
      assert.strictEqual(retryRes.status, 200, JSON.stringify(retryRes.body));
    });

    it('[RA73] must refuse a subset when the offer is all-or-nothing', async () => {
      const key = await createRequest({ mandatory: ['diary'] }); // no allowUserChoice
      const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-consent-grant');
      assert.strictEqual(res.body.error.data.reason, 'choice-not-allowed');
      assert.deepEqual(res.body.error.data.offending, [{ streamId: 'weight', level: 'read' }]);
    });

    it('[RA74] must refuse an access carrying a permission that was never offered', async () => {
      const key = await createRequest(SIDECAR);
      const token = await mintApp([
        { streamId: 'diary', level: 'read' },
        { streamId: 'secret', level: 'read' } // not in the offer
      ]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-consent-grant');
      assert.strictEqual(res.body.error.data.reason, 'not-subset');
      assert.deepEqual(res.body.error.data.offending, [{ streamId: 'secret', level: 'read' }]);
    });

    it('[RA75] must refuse a token that resolves to nothing, while an un-annotated request still accepts it', async () => {
      const annotatedKey = await createRequest(SIDECAR);
      const res = await accept(annotatedKey, 'not-a-real-token');
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-consent-grant');
      assert.strictEqual(res.body.error.data.reason, 'token-invalid');

      // The opaque-token contract every other integrator UI relies on is
      // untouched: without a consent form the same fake token is accepted.
      const plainKey = await createRequest(undefined);
      const plainRes = await accept(plainKey, 'not-a-real-token');
      assert.strictEqual(plainRes.status, 200, JSON.stringify(plainRes.body));
    });

    it('[RA78] must not let the posted body erase or rewrite the consent form', async () => {
      // The party being checked is the one posting, so anything it can put
      // in the body must not be able to switch the check off. The state is
      // the server's record of what the APP asked for; only the outcome
      // fields belong to the poster.
      const overBroad = await mintApp([
        { streamId: 'diary', level: 'read' },
        { streamId: 'secret', level: 'read' } // never offered
      ]);

      // (a) erase the form through a REFUSED post, then accept unchecked.
      const keyA = await createRequest(SIDECAR);
      await coreRequest.post('/reg/access/' + keyA)
        .send({ status: 'REFUSED', reasonId: 'x', message: 'x', consent: null });
      const sneakyA = await accept(keyA, overBroad);
      assert.notStrictEqual(sneakyA.status, 200,
        'an access carrying an unoffered permission was accepted after the form was erased');

      // (b) erase the form on the ACCEPTED post itself.
      const keyB = await createRequest(SIDECAR);
      const resB = await coreRequest.post('/reg/access/' + keyB).send({
        status: 'ACCEPTED',
        username,
        token: overBroad,
        apiEndpoint: 'https://' + username + '.pryv.me/',
        consent: null
      });
      assert.strictEqual(resB.status, 400, JSON.stringify(resB.body));
      assert.strictEqual(resB.body.error.id, 'invalid-consent-grant');

      // (c) replace the form with a laxer one of the poster's choosing.
      const keyC = await createRequest(SIDECAR);
      const resC = await coreRequest.post('/reg/access/' + keyC).send({
        status: 'ACCEPTED',
        username,
        token: overBroad,
        apiEndpoint: 'https://' + username + '.pryv.me/',
        consent: {
          allowUserChoice: true,
          permissions: [
            { streamId: 'diary', level: 'read' },
            { streamId: 'secret', level: 'read' }
          ]
        }
      });
      assert.strictEqual(resC.status, 400, JSON.stringify(resC.body));
      assert.strictEqual(resC.body.error.id, 'invalid-consent-grant');

      // And the stored form is intact after all of that.
      const pollC = await coreRequest.get('/reg/access/' + keyC);
      assert.strictEqual(pollC.body.status, 'NEED_SIGNIN');
      assert.deepEqual(pollC.body.consent.permissions.map((p) => p.streamId), ['diary', 'weight']);
    });

    it('[RA77] must not reach for another core when the user is local', async () => {
      // The local arm is in process. If the route ever took the remote arm
      // for a local user it would call out over HTTP, which on a default
      // single-core install has nowhere to go.
      const calls = [];
      const { checkAcceptedGrant } = require('../src/routes/reg/consentCheck.ts');
      const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const outcome = await checkAcceptedGrant(
        {
          app: global.app,
          username,
          token,
          consentForm: {
            allowUserChoice: true,
            permissions: [
              { streamId: 'diary', level: 'read', mandatory: true },
              { streamId: 'weight', level: 'read', optIn: true }
            ]
          }
        },
        { fetch: async (url) => { calls.push(url); throw new Error('must not fetch for a local user'); } }
      );
      assert.deepStrictEqual(outcome, { ok: true });
      assert.strictEqual(calls.length, 0);
    });

    it('[RA76] must refuse a personal token posted against a consent form', async () => {
      // NO mandatory entry and user choice allowed, so the grant rule alone
      // would accept anything this token carries. What refuses it is the
      // access TYPE, which is what this pins.
      const key = await createRequest({ allowUserChoice: true, optIn: ['weight'] });
      const personalToken = 'personal-' + cuid();
      await fixtureUser.access({ id: 'personal-' + cuid(), type: 'personal', token: personalToken });
      await fixtureUser.session(personalToken);
      const res = await accept(key, personalToken);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-consent-grant');
      // A personal token grants everything; it is not what a page mints for
      // an app, so it is refused on the access TYPE, before any comparison.
      assert.strictEqual(res.body.error.data.reason, 'not-app-access');
    });
  });

  describe('POST /reg/access/:key (refuse)', () => {
    it('[RA30] must refuse with reason', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const refuseRes = await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'REFUSED',
          reasonId: 'USER_DENIED',
          message: 'User denied access'
        });
      assert.strictEqual(refuseRes.status, 403);
      assert.strictEqual(refuseRes.body.status, 'REFUSED');
      assert.strictEqual(refuseRes.body.reasonId, 'USER_DENIED');
    });

    it('[RA31] subsequent poll must return REFUSED state', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      await coreRequest.post('/reg/access/' + key)
        .send({ status: 'REFUSED', reasonId: 'USER_DENIED', message: 'No' });

      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.status, 403);
      assert.strictEqual(pollRes.body.status, 'REFUSED');
    });
  });

  describe('request state storage and delivery', () => {
    const { withInjectedConfig } = require('test-helpers');
    const BODY = {
      requestingAppId: 'test-app',
      requestedPermissions: [{ streamId: 'diary', level: 'read' }]
    };
    const ACCEPT = {
      status: 'ACCEPTED',
      username: 'testuser',
      token: 'state-storage-token',
      apiEndpoint: 'https://state-storage-token@testuser.pryv.me/'
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    it('[RA80] must not write the accepted credential to the platform store', async () => {
      const key = (await coreRequest.post('/reg/access').send(BODY)).body.key;
      await coreRequest.post('/reg/access/' + key).send(ACCEPT);
      const pollRes = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(pollRes.body.token, ACCEPT.token);
      // The platform store is replicated to every core; the request (token,
      // token-bearing apiEndpoint, username) must never reach it.
      const platformDB = require('storages').platformDB;
      assert.strictEqual(await platformDB.getAccessState(key), null);
      // and in no platform-store row at all, under any key
      for (const storeKey of await platformDB.listPlatformKvKeys('access-state/')) {
        const entry = await platformDB.getAccessState(storeKey.slice('access-state/'.length));
        assert.ok(!(storeKey + JSON.stringify(entry)).includes(ACCEPT.token), 'token found in ' + storeKey);
      }
    });

    it('[RA81] must serve ACCEPTED during the retention window, then forget the key', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 1000 } }, async () => {
        const key = (await coreRequest.post('/reg/access').send(BODY)).body.key;
        await coreRequest.post('/reg/access/' + key).send(ACCEPT);
        // clients read the outcome more than once (lib-js polls, then connectFromKey)
        for (let i = 0; i < 2; i++) {
          const res = await coreRequest.get('/reg/access/' + key);
          assert.strictEqual(res.status, 200);
          assert.strictEqual(res.body.token, ACCEPT.token);
        }
        await sleep(1400);
        const late = await coreRequest.get('/reg/access/' + key);
        assert.strictEqual(late.status, 400);
        assert.strictEqual(late.body.error.id, 'unknown-access-key');
      });
    });

    it('[RA82] must apply the same retention window to REFUSED', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 1000 } }, async () => {
        const key = (await coreRequest.post('/reg/access').send(BODY)).body.key;
        await coreRequest.post('/reg/access/' + key).send({ status: 'REFUSED', reasonId: 'USER_DENIED', message: 'No' });
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 403);
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 403);
        await sleep(1400);
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 400);
      });
    });

    it('[RA83] must keep a decided request until expiry when retention is 0', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 0 } }, async () => {
        const key = (await coreRequest.post('/reg/access').send(BODY)).body.key;
        await coreRequest.post('/reg/access/' + key).send(ACCEPT);
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 200);
        await sleep(1400);
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 200);
      });
    });

    it('[RA84] must not start the retention window on a NEED_SIGNIN poll', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 1000 } }, async () => {
        const key = (await coreRequest.post('/reg/access').send(BODY)).body.key;
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 201);
        await sleep(1400);
        await coreRequest.post('/reg/access/' + key).send(ACCEPT);
        assert.strictEqual((await coreRequest.get('/reg/access/' + key)).status, 200);
      });
    });

    it('[RA86] expireAfter is the access lifetime (seconds): it does not shorten the request, and reaches the auth page with deviceName and token', async () => {
      const res = await coreRequest.post('/reg/access')
        .send({ ...BODY, expireAfter: 1, deviceName: 'phone', token: 'app-chosen-token' });
      assert.strictEqual(res.status, 201);
      // expireAfter used to be taken as the request TTL in milliseconds
      await sleep(50);
      const poll = await coreRequest.get('/reg/access/' + res.body.key);
      assert.strictEqual(poll.status, 201);
      assert.strictEqual(poll.body.status, 'NEED_SIGNIN');
      assert.strictEqual(poll.body.expireAfter, 1);
      assert.strictEqual(poll.body.deviceName, 'phone');
      assert.strictEqual(poll.body.token, 'app-chosen-token');
    });

    it('[RA87] without those parameters the NEED_SIGNIN poll carries no deviceName, expireAfter or token key', async () => {
      const res = await coreRequest.post('/reg/access').send(BODY);
      const poll = await coreRequest.get('/reg/access/' + res.body.key);
      for (const k of ['deviceName', 'expireAfter', 'token']) {
        assert.ok(!(k in poll.body), k + ' must be absent');
      }
    });

    it('[RA85] multi-core without core:url must build the poll URL from this core, not the register URL', async () => {
      await withInjectedConfig({ core: { isSingleCore: false, url: null }, dns: { domain: 'ra85.test' } }, async () => {
        const { getPlatform } = require('platform');
        const platform = await getPlatform();
        const self = platform.coreIdToUrl(platform.coreId);
        const res = await coreRequest.post('/reg/access').send(BODY);
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.poll, self + 'reg/access/' + res.body.key);
      });
    });
  });

  describe('acting for a controlled account (actAs, delegation hint)', () => {
    const { withInjectedConfig } = require('test-helpers');
    const BODY = {
      requestingAppId: 'test-app',
      requestedPermissions: [{ streamId: 'diary', level: 'read' }]
    };
    const HINT = {
      isDelegatedAccess: true,
      controlledUsername: 'kiduser',
      delegate: { username: 'parentuser', hostSlug: 'core-a' }
    };
    const ACCEPT_KID = {
      status: 'ACCEPTED',
      username: 'kiduser',
      token: 'kid-app-token',
      apiEndpoint: 'https://kid-app-token@kiduser.pryv.me/',
      delegation: HINT
    };
    const newKey = async (extra) => {
      const res = await coreRequest.post('/reg/access').send({ ...BODY, ...extra });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.key;
    };

    it('[RA88] actAs is stored and echoed on the NEED_SIGNIN poll only when sent', async () => {
      for (const actAs of ['allow', 'deny', 'kiduser']) {
        const poll = await coreRequest.get('/reg/access/' + await newKey({ actAs }));
        assert.strictEqual(poll.body.actAs, actAs);
      }
      const plain = await coreRequest.get('/reg/access/' + await newKey());
      assert.ok(!('actAs' in plain.body), 'actAs must be absent');
      const nulled = await coreRequest.get('/reg/access/' + await newKey({ actAs: null }));
      assert.ok(!('actAs' in nulled.body), 'a null actAs is not sent');
    });

    it('[RA89] an invalid actAs is refused with 400', async () => {
      for (const actAs of ['', 'Not A User', 42, true, { username: 'kiduser' }, ['allow']]) {
        const res = await coreRequest.post('/reg/access').send({ ...BODY, actAs });
        assert.strictEqual(res.status, 400, 'actAs ' + JSON.stringify(actAs));
        assert.strictEqual(res.body.error.id, 'invalid-parameters');
      }
    });

    it('[RA90] the delegation hint is echoed on the POST response and on every ACCEPTED poll of the retention window', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 1000 } }, async () => {
        const key = await newKey({ actAs: 'allow' });
        const post = await coreRequest.post('/reg/access/' + key).send(ACCEPT_KID);
        assert.strictEqual(post.status, 200);
        assert.deepStrictEqual(post.body.delegation, HINT);
        for (let i = 0; i < 2; i++) {
          const poll = await coreRequest.get('/reg/access/' + key);
          assert.strictEqual(poll.status, 200);
          assert.strictEqual(poll.body.username, 'kiduser');
          assert.deepStrictEqual(poll.body.delegation, HINT);
        }
      });
    });

    it('[RA91] a malformed hint is refused with 400 and leaves the request pending', async () => {
      const bad = [
        'yes',
        [],
        { ...HINT, isDelegatedAccess: 'true' },
        { ...HINT, controlledUsername: '' },
        { ...HINT, delegate: 'parentuser' },
        { ...HINT, delegate: { hostSlug: 'core-a' } },
        { ...HINT, delegate: { username: 'parentuser', token: 'leak' } },
        { ...HINT, extra: 1 }
      ];
      const key = await newKey();
      for (const delegation of bad) {
        const res = await coreRequest.post('/reg/access/' + key).send({ ...ACCEPT_KID, delegation });
        assert.strictEqual(res.status, 400, JSON.stringify(delegation));
        assert.strictEqual(res.body.error.id, 'invalid-parameters');
      }
      const poll = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(poll.body.status, 'NEED_SIGNIN');
    });

    it('[RA92] a hint naming another account than the granted one is refused', async () => {
      const key = await newKey();
      const res = await coreRequest.post('/reg/access/' + key)
        .send({ ...ACCEPT_KID, username: 'parentuser' });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error.message, /controlledUsername/);
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');
    });

    it('[RA93] a hint is refused on a non-ACCEPTED outcome', async () => {
      const key = await newKey();
      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'REFUSED', reasonId: 'USER_DENIED', message: 'No', delegation: HINT });
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');
    });

    it('[RA94] without a hint the ACCEPTED bodies keep exactly their legacy keys', async () => {
      const key = await newKey();
      const { delegation, ...legacy } = ACCEPT_KID;
      const post = await coreRequest.post('/reg/access/' + key).send({ ...legacy, delegation: null });
      assert.deepStrictEqual(Object.keys(post.body).sort(), ['apiEndpoint', 'status', 'token', 'username']);
      const poll = await coreRequest.get('/reg/access/' + key);
      assert.deepStrictEqual(Object.keys(poll.body).sort(), ['apiEndpoint', 'status', 'token', 'username']);
    });
  });

  describe('credential hand-off (shared-secret delivery)', () => {
    // Real user + real app tokens minted in storage: the conversion path
    // creates a shared secret authenticated AS the app token, so the token
    // must resolve to a live access on this (single) core.
    const { withInjectedConfig } = require('test-helpers');
    let fixtures, fixtureUser, username;
    let counter = 0;

    const OFFER = [
      { streamId: 'diary', level: 'read', defaultName: 'Journal' },
      { streamId: 'weight', level: 'read' }
    ];
    const SIDECAR = { allowUserChoice: true, mandatory: ['diary'], optIn: ['weight'] };

    before(async function () {
      this.timeout(30000);
      fixtures = getNewFixture();
      username = cuid();
      fixtureUser = await fixtures.user(username);
      await fixtureUser.stream({ id: 'diary', name: 'Journal' });
      await fixtureUser.stream({ id: 'weight', name: 'Weight' });
    });

    after(async function () {
      this.timeout(30000);
      await fixtures.clean();
    });

    async function mintApp (permissions) {
      const n = ++counter;
      const token = 'tok-' + n + '-' + cuid();
      await fixtureUser.access({
        id: 'acc-' + n + '-' + cuid(),
        type: 'app',
        name: 'handoff-app-' + n,
        token,
        permissions
      });
      return token;
    }

    async function createRequest (extra) {
      const res = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app', requestedPermissions: OFFER, ...extra });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.key;
    }

    const apiEndpoint = () => 'https://' + username + '.pryv.me/';

    function accept (key, token) {
      return coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username, token, apiEndpoint: apiEndpoint() });
    }

    // A syntactically valid shared-secret key (eventId.randomPart), for the
    // shape-validation tests that must not depend on a real secret existing.
    const fakeKey = (seed) => cuid() + '.' + String(seed).repeat(40).slice(0, 40);

    it('[RA95] the 201 echoes credentialHandoff only when the request set it; an unknown value is refused', async () => {
      const withIt = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app', requestedPermissions: OFFER, credentialHandoff: 'shared-secret' });
      assert.strictEqual(withIt.status, 201);
      assert.strictEqual(withIt.body.credentialHandoff, 'shared-secret');

      const without = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app', requestedPermissions: OFFER });
      assert.strictEqual(without.status, 201);
      assert.strictEqual(without.body.credentialHandoff, undefined);

      const bad = await coreRequest.post('/reg/access')
        .send({ requestingAppId: 'test-app', requestedPermissions: OFFER, credentialHandoff: 'nope' });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.error.id, 'invalid-parameters');
    });

    it('[RA96] the NEED_SIGNIN poll echoes credentialHandoff, and omits it otherwise', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const poll = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(poll.status, 201);
      assert.strictEqual(poll.body.credentialHandoff, 'shared-secret');

      const key2 = await createRequest({});
      const poll2 = await coreRequest.get('/reg/access/' + key2);
      assert.strictEqual(poll2.body.credentialHandoff, undefined);
    });

    it('[RA97] a shape-L accept on a hand-off request converts to a one-time secret; the poll carries only the key and the app retrieves once', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const token = await mintApp([{ streamId: 'diary', level: 'read' }]);

      const res = await accept(key, token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ACCEPTED');
      assert.strictEqual(res.body.handoff.type, 'shared-secret');
      assert.ok(res.body.handoff.key, 'expected a handoff key');
      assert.strictEqual(res.body.token, undefined);

      const poll = await coreRequest.get('/reg/access/' + key);
      assert.strictEqual(poll.body.status, 'ACCEPTED');
      assert.strictEqual(poll.body.handoff.key, res.body.handoff.key);
      assert.strictEqual(poll.body.token, undefined);
      assert.strictEqual(poll.body.apiEndpoint, apiEndpoint());

      const stored = await accessState.get(key);
      assert.strictEqual(stored.token, undefined, 'the token must not rest in the state');
      assert.ok(stored.handoff);

      const r1 = await coreRequest.post('/' + username + '/shared-secrets/retrieve')
        .send({ key: poll.body.handoff.key });
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
      assert.deepStrictEqual(r1.body.secret, { username, token, apiEndpoint: apiEndpoint() });

      const r2 = await coreRequest.post('/' + username + '/shared-secrets/retrieve')
        .send({ key: poll.body.handoff.key });
      assert.strictEqual(r2.status, 403, JSON.stringify(r2.body));
      assert.strictEqual(r2.body.error.data.id, 'shared-secret-unavailable');
      assert.strictEqual(r2.body.secret, undefined, 'the credential must never be served twice');
    });

    it('[RA98] without credentialHandoff a shape-L accept is byte-identical to the legacy ACCEPTED body', async () => {
      const key = await createRequest({});
      const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { status: 'ACCEPTED', username, token, apiEndpoint: apiEndpoint() });
      const poll = await coreRequest.get('/reg/access/' + key);
      assert.deepStrictEqual(poll.body, { status: 'ACCEPTED', username, token, apiEndpoint: apiEndpoint() });
    });

    it('[RA99] the invalid accept shapes are each refused with 400 naming the hand-off rule, leaving the request pending', async () => {
      // (a) handoff on a request that did not ask for it
      const plainKey = await createRequest({});
      const a = await coreRequest.post('/reg/access/' + plainKey)
        .send({ status: 'ACCEPTED', username, apiEndpoint: apiEndpoint(), handoff: { type: 'shared-secret', key: fakeKey('a') } });
      assert.strictEqual(a.status, 400);
      assert.strictEqual(a.body.error.id, 'invalid-parameters');
      assert.match(a.body.error.message, /credentialHandoff/,
        'the refusal must name the hand-off rule, not the legacy "token required"');
      assert.strictEqual((await coreRequest.get('/reg/access/' + plainKey)).body.status, 'NEED_SIGNIN');

      // (b) token AND handoff both present
      const kB = await createRequest({ credentialHandoff: 'shared-secret' });
      const b = await coreRequest.post('/reg/access/' + kB)
        .send({ status: 'ACCEPTED', username, token: 'tok', apiEndpoint: apiEndpoint(), handoff: { type: 'shared-secret', key: fakeKey('b') } });
      assert.strictEqual(b.status, 400);
      assert.match(b.body.error.message, /not both/);

      // (c) malformed handoff.key
      const kC = await createRequest({ credentialHandoff: 'shared-secret' });
      const c = await coreRequest.post('/reg/access/' + kC)
        .send({ status: 'ACCEPTED', username, apiEndpoint: apiEndpoint(), handoff: { type: 'shared-secret', key: 'not a key' } });
      assert.strictEqual(c.status, 400);
      assert.match(c.body.error.message, /handoff\.key/);

      // (d) wrong handoff.type
      const kD = await createRequest({ credentialHandoff: 'shared-secret' });
      const d = await coreRequest.post('/reg/access/' + kD)
        .send({ status: 'ACCEPTED', username, apiEndpoint: apiEndpoint(), handoff: { type: 'x', key: fakeKey('d') } });
      assert.strictEqual(d.status, 400);
      assert.match(d.body.error.message, /handoff\.type/);

      // (e) apiEndpoint that is not http(s)
      const kE = await createRequest({ credentialHandoff: 'shared-secret' });
      const e = await coreRequest.post('/reg/access/' + kE)
        .send({ status: 'ACCEPTED', username, apiEndpoint: 'javascript:alert(1)', handoff: { type: 'shared-secret', key: fakeKey('e') } });
      assert.strictEqual(e.status, 400);
      assert.match(e.body.error.message, /apiEndpoint/);
      assert.strictEqual((await coreRequest.get('/reg/access/' + kE)).body.status, 'NEED_SIGNIN');
    });

    it('[RA100] a UI-created hand-off (shape H) without a consent form is stored verbatim; the poll carries no token', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const handoffKey = fakeKey('h');
      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username, apiEndpoint: apiEndpoint(), handoff: { type: 'shared-secret', key: handoffKey } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.handoff, { type: 'shared-secret', key: handoffKey });
      assert.strictEqual(res.body.token, undefined);

      const stored = await accessState.get(key);
      assert.strictEqual(stored.token, undefined);
      assert.deepStrictEqual(stored.handoff, { type: 'shared-secret', key: handoffKey });

      const poll = await coreRequest.get('/reg/access/' + key);
      assert.deepStrictEqual(poll.body.handoff, { type: 'shared-secret', key: handoffKey });
      assert.strictEqual(poll.body.token, undefined);
    });

    it('[RA101] a consent-form request refuses a UI-created hand-off (shape H) and stays pending', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret', consent: SIDECAR });
      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username, apiEndpoint: apiEndpoint(), handoff: { type: 'shared-secret', key: fakeKey('c') } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.match(res.body.error.message, /consent-form/);
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');
    });

    it('[RA102] when shared secrets are disabled the conversion falls back to inline delivery', async () => {
      await withInjectedConfig({ sharedSecrets: { enabled: false } }, async () => {
        const key = await createRequest({ credentialHandoff: 'shared-secret' });
        const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
        const res = await accept(key, token);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.token, token);
        assert.strictEqual(res.body.handoff, undefined);
      });
    });

    it('[RA103] an access forbidden from creating shared secrets falls back to inline delivery', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const token = await mintApp([
        { streamId: 'diary', level: 'read' },
        { feature: 'secretSharing', setting: 'forbidden' }
      ]);
      const res = await accept(key, token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.token, token);
      assert.strictEqual(res.body.handoff, undefined);
    });

    it('[RA104] a consent-form hand-off request checks the grant first: a bad grant refuses with no secret, a good grant converts', async () => {
      const badKey = await createRequest({ credentialHandoff: 'shared-secret', consent: SIDECAR });
      const badToken = await mintApp([{ streamId: 'weight', level: 'read' }]); // drops mandatory diary
      const badRes = await accept(badKey, badToken);
      assert.strictEqual(badRes.status, 400);
      assert.strictEqual(badRes.body.error.id, 'invalid-consent-grant');
      assert.strictEqual((await coreRequest.get('/reg/access/' + badKey)).body.status, 'NEED_SIGNIN');

      const goodKey = await createRequest({ credentialHandoff: 'shared-secret', consent: SIDECAR });
      const goodToken = await mintApp([{ streamId: 'diary', level: 'read' }]);
      const goodRes = await accept(goodKey, goodToken);
      assert.strictEqual(goodRes.status, 200, JSON.stringify(goodRes.body));
      assert.strictEqual(goodRes.body.handoff.type, 'shared-secret');
      assert.strictEqual(goodRes.body.token, undefined);
    });

    it('[RA105] a hand-off ACCEPTED body is served through the retention window, then the key is unknown', async () => {
      await withInjectedConfig({ access: { terminalRetentionMs: 1000 } }, async () => {
        const key = await createRequest({ credentialHandoff: 'shared-secret' });
        const token = await mintApp([{ streamId: 'diary', level: 'read' }]);
        await accept(key, token);
        const p1 = await coreRequest.get('/reg/access/' + key);
        assert.ok(p1.body.handoff.key);
        const p2 = await coreRequest.get('/reg/access/' + key);
        assert.ok(p2.body.handoff.key);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const p3 = await coreRequest.get('/reg/access/' + key);
        assert.strictEqual(p3.status, 400);
        assert.strictEqual(p3.body.error.id, 'unknown-access-key');
      });
    });

    it('[RA106] the conversion creates the secret on the platform-resolved core, never the posted apiEndpoint host', async () => {
      const { createHandoff } = require('../src/routes/reg/credentialHandoff.ts');
      const calls = [];
      const fakePlatform = {
        isSingleCore: false,
        coreId: 'coreA',
        getUserCore: async () => 'coreB',
        coreIdToUrl: (id) => 'https://' + id + '.core.test/'
      };
      const result = await createHandoff({
        app: global.app,
        username,
        token: 'tok-remote',
        apiEndpoint: 'https://posted.example/' + username + '/',
        requestingAppId: 'test-app',
        ttlSeconds: 600,
        platform: fakePlatform,
        fetch: async (url) => {
          calls.push(url);
          return { ok: true, json: async () => ({ sharedSecret: { key: fakeKey('r') } }) };
        }
      });
      assert.ok('handoff' in result, JSON.stringify(result));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0], 'https://coreB.core.test/' + encodeURIComponent(username) + '/shared-secrets');
    });

    it('[RA107] a handoff on a non-ACCEPTED post is refused before any write, leaving the request pending', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'REFUSED', reasonId: 'x', message: 'x', handoff: { type: 'shared-secret', key: fakeKey('n') } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.match(res.body.error.message, /ACCEPTED/);
      const stored = await accessState.get(key);
      assert.strictEqual(stored.status, 'NEED_SIGNIN', 'the poisoned status must not stick');
      assert.strictEqual(stored.handoff, undefined, 'the unvalidated handoff must never be written');
    });

    it('[RA108] a shape-H apiEndpoint carrying an ?auth= token is refused', async () => {
      const key = await createRequest({ credentialHandoff: 'shared-secret' });
      const res = await coreRequest.post('/reg/access/' + key)
        .send({
          status: 'ACCEPTED',
          username,
          apiEndpoint: 'https://' + username + '.pryv.me/?auth=leaked-token',
          handoff: { type: 'shared-secret', key: fakeKey('q') }
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.id, 'invalid-parameters');
      assert.match(res.body.error.message, /auth token/);
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN');
    });
  });

  describe('POST /reg/access/:key (errors)', () => {
    it('[RA40] must return 400 for invalid status', async () => {
      const createRes = await coreRequest.post('/reg/access')
        .send({
          requestingAppId: 'test-app',
          requestedPermissions: [{ streamId: 'diary', level: 'read' }]
        });
      const key = createRes.body.key;

      const res = await coreRequest.post('/reg/access/' + key)
        .send({ status: 'INVALID' });
      assert.strictEqual(res.status, 400);
    });

    it('[RA41] must return 400 for unknown key', async () => {
      const res = await coreRequest.post('/reg/access/nonexistentkey00')
        .send({ status: 'REFUSED', reasonId: 'test', message: 'test' });
      assert.strictEqual(res.status, 400);
    });
  });
});
