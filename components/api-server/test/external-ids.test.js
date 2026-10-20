/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const crypto = require('node:crypto');
const { getConfig } = require('@pryv/boiler');
const { extIdLookupBudget } = require('../src/routes/reg/extIdLookupBudget.ts');

function blinded () {
  return crypto.randomBytes(32).toString('base64url');
}

describe('[XID] external ids (namespaces, claims, lookup)', function () {
  let fixtures, adminKey, ns;
  const users = {};

  async function makeUser () {
    const username = cuid();
    const user = await fixtures.user(username);
    const token = cuid();
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const appToken = cuid();
    await user.access({ token: appToken, type: 'app', permissions: [{ streamId: '*', level: 'manage' }] });
    return { username, token, appToken };
  }

  function claim (u, body) {
    return coreRequest.post(`/${u.username}/account/external-ids`).set('Authorization', u.token).send(body);
  }

  function lookup (body) {
    return coreRequest.post('/reg/ext-id/cores').send(body);
  }

  before(async function () {
    await initTests();
    await initCore();
    // The test core registers no system method by default; the admin routes need them.
    const app = globalThis.app;
    if (!app.systemAPI.has('system.extIdNamespaces.set')) {
      await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    }
    // Account deletion (DELETE /users/:username) is not registered by default either.
    if (!app.api.has('auth.delete')) {
      await require('api-server/src/methods/auth/delete.ts').default(app.api);
    }
    adminKey = (await getConfig()).get('auth:adminAccessKey');
    fixtures = getNewFixture();
    users.a = await makeUser();
    users.b = await makeUser();
    ns = 'ehr-' + cuid().slice(-8).toLowerCase();
    await extIdLookupBudget.clear();
  });

  afterEach(async function () {
    await extIdLookupBudget.clear();
  });

  after(async function () {
    await fixtures.context.cleanEverything();
  });

  describe('[XIDA] admin namespaces', function () {
    it('[XIDA1] PUT creates (201) without returning the salt, a second PUT updates (200)', async function () {
      const created = await coreRequest.put('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey).send({ label: 'Practice EHR' });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      assert.deepStrictEqual(Object.keys(created.body.namespace).sort(), ['createdAt', 'defaultMode', 'label', 'namespace']);
      assert.strictEqual(created.body.namespace.defaultMode, 'hint');
      const updated = await coreRequest.put('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey).send({ label: 'Practice EHR (prod)' });
      assert.strictEqual(updated.status, 200);
      assert.strictEqual(updated.body.namespace.label, 'Practice EHR (prod)');
      assert.strictEqual(updated.body.namespace.createdAt, created.body.namespace.createdAt);
    });

    it('[XIDA2] GET one and the list; unknown is 404; the admin key is required; a bad name is refused', async function () {
      const one = await coreRequest.get('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey);
      assert.strictEqual(one.status, 200);
      assert.strictEqual(one.body.namespace.namespace, ns);
      const list = await coreRequest.get('/system/admin/ext-id-ns').set('authorization', adminKey);
      assert.strictEqual(list.status, 200);
      assert.ok(list.body.namespaces.some((n) => n.namespace === ns));
      assert.ok(!JSON.stringify(list.body).includes('salt'));
      assert.strictEqual((await coreRequest.get('/system/admin/ext-id-ns/unknown-ns').set('authorization', adminKey)).status, 404);
      // The /system routes answer "not found" without the admin key.
      assert.strictEqual((await coreRequest.get('/system/admin/ext-id-ns')).status, 404);
      const bad = await coreRequest.put('/system/admin/ext-id-ns/Bad_Name').set('authorization', adminKey).send({});
      assert.strictEqual(bad.status, 400);
    });
  });

  describe('[XIDC] claims', function () {
    it('[XIDC1] claim (201), idempotent claim (200), list without the value', async function () {
      const v = blinded();
      const res = await claim(users.a, { namespace: ns, blindedValue: v });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.externalId.namespace, ns);
      assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: v })).status, 200);
      const list = await coreRequest.get(`/${users.a.username}/account/external-ids`).set('Authorization', users.a.token);
      assert.strictEqual(list.status, 200);
      assert.deepStrictEqual(list.body.externalIds.map((x) => x.namespace), [ns]);
      assert.ok(!JSON.stringify(list.body).includes(v), 'list never returns the value');
      // The platform key holds the value as is in cleartext mode only.
      const platform = await require('platform').getPlatform();
      // A run with `platform__piiMode=cleartext` must really run in that mode.
      if (process.env.platform__piiMode === 'cleartext') assert.strictEqual(platform.piiModeIsHashed, false);
      const inKey = (await platform.getAllCoreRows('ext-id/')).some((r) => r.key.includes(v));
      assert.strictEqual(inKey, !platform.piiModeIsHashed, 'key form matches platform.piiMode (hashed: ' + platform.piiModeIsHashed + ')');
      users.a.value = v;
    });

    it('[XIDC2] an app token cannot claim nor list', async function () {
      const res = await coreRequest.post(`/${users.a.username}/account/external-ids`).set('Authorization', users.a.appToken)
        .send({ namespace: ns, blindedValue: blinded() });
      assert.strictEqual(res.status, 403);
      const list = await coreRequest.get(`/${users.a.username}/account/external-ids`).set('Authorization', users.a.appToken);
      assert.strictEqual(list.status, 403);
    });

    it('[XIDC3] another account of the same core gets 409 value-taken, naming no account', async function () {
      const res = await claim(users.b, { namespace: ns, blindedValue: users.a.value });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, 'external-id-already-claimed');
      assert.deepStrictEqual(res.body.error.data, { namespace: ns, reason: 'value-taken' });
      const raw = JSON.stringify(res.body);
      assert.ok(!raw.includes(users.a.username) && !raw.includes(users.a.value));
    });

    it('[XIDC4] concurrent claims of one id by two accounts: exactly one 201', async function () {
      const v = blinded();
      const c = await makeUser();
      const [r1, r2] = await Promise.all([
        claim(users.b, { namespace: ns, blindedValue: v }),
        claim(c, { namespace: ns, blindedValue: v })
      ]);
      assert.deepStrictEqual([r1.status, r2.status].sort(), [201, 409]);
      const winner = r1.status === 201 ? users.b : c;
      await coreRequest.delete(`/${winner.username}/account/external-ids/${ns}`).set('Authorization', winner.token);
    });

    it('[XIDC5] a second id in the namespace is namespace-taken; replace swaps it and frees the old one', async function () {
      const v2 = blinded();
      const refused = await claim(users.a, { namespace: ns, blindedValue: v2 });
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(refused.body.error.data.reason, 'namespace-taken');
      const replaced = await coreRequest.put(`/${users.a.username}/account/external-ids/${ns}`).set('Authorization', users.a.token)
        .send({ blindedValue: v2 });
      assert.strictEqual(replaced.status, 200, JSON.stringify(replaced.body));
      assert.strictEqual((await lookup({ namespace: ns, blindedValue: users.a.value })).status, 404, 'old id released');
      assert.strictEqual((await lookup({ namespace: ns, blindedValue: v2 })).status, 200);
      users.a.value = v2;
    });

    it('[XIDC6] release (idempotent) frees the id for another account', async function () {
      const del = await coreRequest.delete(`/${users.a.username}/account/external-ids/${ns}`).set('Authorization', users.a.token);
      assert.strictEqual(del.status, 200);
      assert.deepStrictEqual(del.body.released, true);
      assert.strictEqual((await coreRequest.delete(`/${users.a.username}/account/external-ids/${ns}`).set('Authorization', users.a.token)).status, 200);
      assert.strictEqual((await claim(users.b, { namespace: ns, blindedValue: users.a.value })).status, 201);
      users.b.value = users.a.value;
    });

    it('[XIDC7] malformed values and unknown namespaces are refused without echoing the value', async function () {
      const bad = 'not*base64url';
      const res = await claim(users.a, { namespace: ns, blindedValue: bad });
      assert.strictEqual(res.status, 400);
      assert.ok(!JSON.stringify(res.body).includes(bad));
      assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: 'c2hvcnQ' })).status, 400, 'too short');
      assert.strictEqual((await claim(users.a, { namespace: 'no-such-ns', blindedValue: blinded() })).status, 400);
    });
  });

  describe('[XIDL] lookup', function () {
    it('[XIDLU1] POST answers the core URL; unclaimed and unknown namespace are the same 404; GET is not a route', async function () {
      const res = await lookup({ namespace: ns, blindedValue: users.b.value });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(typeof res.body.server, 'string');
      const unclaimed = await lookup({ namespace: ns, blindedValue: blinded() });
      const unknownNs = await lookup({ namespace: 'no-such-ns', blindedValue: blinded() });
      assert.strictEqual(unclaimed.status, 404);
      assert.strictEqual(unknownNs.status, 404);
      assert.strictEqual(unclaimed.body.error.id, unknownNs.body.error.id);
      assert.strictEqual(unclaimed.body.error.message, unknownNs.body.error.message);
      assert.strictEqual((await coreRequest.get('/reg/ext-id/cores?namespace=' + ns)).status, 404);
    });

    it('[XIDLU2] the per-address budget: 10 lookups pass, the 11th is 429', async function () {
      for (let i = 0; i < 10; i++) {
        assert.strictEqual((await lookup({ namespace: ns, blindedValue: blinded() })).status, 404);
      }
      const over = await lookup({ namespace: ns, blindedValue: blinded() });
      assert.strictEqual(over.status, 429);
      assert.ok(over.headers['retry-after'] != null);
    });

    it('[XIDLU3] claim refusals count in the same budget, successful claims do not', async function () {
      for (let i = 0; i < 10; i++) {
        assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: users.b.value })).status, 409);
      }
      assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: blinded() })).status, 429, 'over budget: refused before the claim');
      await extIdLookupBudget.clear();
      for (let i = 0; i < 12; i++) {
        const c = await makeUser();
        assert.strictEqual((await claim(c, { namespace: ns, blindedValue: blinded() })).status, 201);
      }
    });
  });

  describe('[XIDG] the blinded value is never logged', function () {
    // Every log line of every logger, while `fn` runs (same capture as the
    // credentials log test).
    async function captureLogs (fn) {
      const { inspect } = require('node:util');
      const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
      const original = proto.log;
      const lines = [];
      proto.log = function (level, msg, ...rest) {
        lines.push({ level, name: this._name(), text: String(msg) + (rest.length > 0 ? ' ' + inspect(rest, { depth: 8 }) : '') });
        return original.call(this, level, msg, ...rest);
      };
      try {
        await fn();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        proto.log = original;
      }
      return lines;
    }

    // Mutation checks (each must make this test fail): echo the raw value in
    // `parseBlindedValue`'s error; remove `blindedValue` from the
    // `originalQuery` strip list of `MethodContext.ts` (the query value then
    // reaches the audit record and its log line).
    it('[XIDG1] claim, refusals, malformed input, replace, release, list and lookups log no value', async function () {
      const c = await makeUser();
      const v = blinded();
      const v2 = blinded();
      const malformed = 'bad*' + blinded();
      const bodies = [];
      const probe = 'xidg-debug-probe-' + cuid();
      const lines = await captureLogs(async () => {
        // The capture must see debug lines too, whatever the configured level.
        require('@pryv/boiler').getLogger('xidg-probe').debug(probe);
        bodies.push((await claim(c, { namespace: ns, blindedValue: v })).body);
        bodies.push((await claim(c, { namespace: ns, blindedValue: v })).body);
        bodies.push((await claim(users.a, { namespace: ns, blindedValue: v })).body);
        bodies.push((await claim(c, { namespace: ns, blindedValue: malformed })).body);
        bodies.push((await lookup({ namespace: ns, blindedValue: v })).body);
        bodies.push((await lookup({ namespace: ns, blindedValue: malformed })).body);
        bodies.push((await coreRequest.put(`/${c.username}/account/external-ids/${ns}`).set('Authorization', c.token).send({ blindedValue: v2 })).body);
        bodies.push((await coreRequest.get(`/${c.username}/account/external-ids`).set('Authorization', c.token)).body);
        bodies.push((await coreRequest.delete(`/${c.username}/account/external-ids/${ns}`).set('Authorization', c.token)).body);
        // A mistaken client putting the value in the query of an audited route.
        bodies.push((await coreRequest.get(`/${c.username}/account/external-ids`).set('Authorization', c.token).query({ blindedValue: v2 })).body);
      });
      assert.ok(lines.some((l) => l.name.endsWith('request-trace') && l.text.includes('/reg/ext-id/cores')),
        'the log channel delivers: the lookup is traced');
      assert.ok(lines.some((l) => l.text.includes(probe)), 'the capture sees debug lines');
      for (const secret of [v, v2, malformed]) {
        assert.deepStrictEqual(lines.filter((l) => l.text.includes(secret)), [], 'no log line holds a value');
      }
      const responses = JSON.stringify(bodies);
      assert.ok(!responses.includes(v2) && !responses.includes(malformed) && !responses.includes(v), 'no response holds a value');
      const audit = await coreRequest.get(`/${c.username}/events`).set('Authorization', c.token).query({ streams: JSON.stringify([':_audit:']) });
      const auditText = JSON.stringify(audit.body);
      assert.ok(!auditText.includes(v) && !auditText.includes(v2) && !auditText.includes(malformed), 'the audit trail holds no value');
    });
  });

  describe('[XIDD] deletion', function () {
    it('[XIDD1] a namespace with claimed ids is not deleted without force', async function () {
      const res = await coreRequest.delete('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.id, 'external-id-namespace-in-use');
    });

    it('[XIDD2] deleting an account releases its ids at once', async function () {
      const c = await makeUser();
      const v = blinded();
      assert.strictEqual((await claim(c, { namespace: ns, blindedValue: v })).status, 201);
      const del = await coreRequest.delete(`/users/${c.username}`).set('Authorization', adminKey);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
      assert.strictEqual((await lookup({ namespace: ns, blindedValue: v })).status, 404);
      assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: v })).status, 201, 'claimable again by another account');
    });

    it('[XIDD3] force deletes the namespace row; its ids then refuse as an unknown namespace', async function () {
      const res = await coreRequest.delete('/system/admin/ext-id-ns/' + ns + '?force=true').set('authorization', adminKey);
      assert.strictEqual(res.status, 204);
      assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: blinded() })).status, 400);
      const list = await coreRequest.get(`/${users.a.username}/account/external-ids`).set('Authorization', users.a.token);
      assert.deepStrictEqual(list.body.externalIds, []);
    });
  });
});
