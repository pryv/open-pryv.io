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
