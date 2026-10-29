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

  // Creates the namespace, or updates it when it exists (201 or 200). The
  // blocks below call it in their own `before`, so each one runs alone (with
  // --grep) as well as after [XIDA].
  async function ensureNamespace () {
    const put = await coreRequest.put('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey).send({ label: 'Practice EHR' });
    assert.ok([200, 201].includes(put.status), JSON.stringify(put.body));
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
    before(ensureNamespace);

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

  describe('[XIDH] holder answer (core to core)', function () {
    before(ensureNamespace);

    function holds (body, key = adminKey) {
      const req = coreRequest.post('/system/ext-id/holds');
      return (key != null ? req.set('authorization', key) : req).send(body);
    }

    it('[XIDH1] answers a boolean only: true for the holder, false for another account and for an unclaimed id', async function () {
      const holder = await makeUser();
      const other = await makeUser();
      const v = blinded();
      assert.strictEqual((await claim(holder, { namespace: ns, blindedValue: v })).status, 201);
      const yes = await holds({ username: holder.username, namespace: ns, blindedValue: v });
      assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
      assert.deepStrictEqual(Object.keys(yes.body).filter((k) => k !== 'meta'), ['holds']);
      assert.strictEqual(yes.body.holds, true);
      assert.strictEqual((await holds({ username: other.username, namespace: ns, blindedValue: v })).body.holds, false);
      assert.strictEqual((await holds({ username: holder.username, namespace: ns, blindedValue: blinded() })).body.holds, false);
    });

    it('[XIDH2] an account that is not on this core is 404; a bad namespace or value is 400 without the value', async function () {
      const v = blinded();
      assert.strictEqual((await holds({ username: 'nobody' + cuid().slice(-6).toLowerCase(), namespace: ns, blindedValue: v })).status, 404);
      const unknownNs = await holds({ username: users.a.username, namespace: 'no-such-ns', blindedValue: v });
      assert.strictEqual(unknownNs.status, 400);
      assert.ok(!JSON.stringify(unknownNs.body).includes(v));
      const malformed = await holds({ username: users.a.username, namespace: ns, blindedValue: 'short' });
      assert.strictEqual(malformed.status, 400);
      assert.ok(!JSON.stringify(malformed.body).includes('short'));
    });

    it('[XIDH3] the admin key is required', async function () {
      assert.strictEqual((await holds({ username: users.a.username, namespace: ns, blindedValue: blinded() }, null)).status, 404);
      assert.strictEqual((await holds({ username: users.a.username, namespace: ns, blindedValue: blinded() }, users.a.token)).status, 404);
    });
  });

  describe('[XIDAR] admin release (squatting remedy)', function () {
    const nock = require('nock');
    const { injectTestConfigSnapshot, pollUntil } = require('test-helpers');
    const { useNock } = require('test-helpers/src/nockScope.ts');
    useNock();
    const MANDRILL = 'https://mandrillapp.local';
    const MANDRILL_PATH = '/api/1.0/messages/send-template.json';

    before(ensureNamespace);

    function release (body, key = adminKey) {
      const req = coreRequest.post('/system/admin/ext-id/release');
      return (key != null ? req.set('authorization', key) : req).send(body);
    }

    async function userWithEmail () {
      const username = cuid().toLowerCase();
      const user = await fixtures.user(username, { email: username + '@release.example.com', language: 'en' });
      const token = cuid();
      await user.access({ token, type: 'personal' });
      await user.session(token);
      return { username, token };
    }

    async function auditRows (u) {
      const res = await coreRequest.get(`/${u.username}/events`).set('Authorization', u.token).query({ streams: [':_audit:'], limit: 200 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body.events ?? [];
    }

    it('[XIDAR1] squatter claims, admin releases, the patient claims; the answer names no account and holds no value', async function () {
      const squatter = await makeUser();
      const patient = await makeUser();
      const v = blinded();
      assert.strictEqual((await claim(squatter, { namespace: ns, blindedValue: v })).status, 201);
      assert.strictEqual((await claim(patient, { namespace: ns, blindedValue: v })).status, 409);
      const res = await release({ namespace: ns, blindedValue: v, reason: 'claimed by mistake' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.released, true);
      assert.strictEqual(res.body.notified, 'audit-only', 'mail is off in the test configuration');
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes(squatter.username) && !text.includes(v), 'no account, no value');
      const listed = await coreRequest.get(`/${squatter.username}/account/external-ids`).set('Authorization', squatter.token);
      assert.deepStrictEqual(listed.body.externalIds, []);
      assert.strictEqual((await claim(patient, { namespace: ns, blindedValue: v })).status, 201, 'the patient can claim it now');
      const patientTrail = await auditRows(patient);
      assert.ok(!patientTrail.some((e) => e.content?.action === 'account.externalIds.adminRelease'), 'only the holder\'s trail records it');
    });

    it('[XIDAR6] a stale index row of this core with no account behind it: 404, the row left to the reconcile', async function () {
      const { getExternalIdsService } = require('business/src/external-ids/service.ts');
      const field = await (await getExternalIdsService()).parseFlowField({ namespace: ns, blindedValue: blinded() });
      const platform = await require('platform').getPlatform();
      const key = field.tokens.nsToken + '/' + field.tokens.valueToken;
      assert.strictEqual(await platform.claimCoreRow('ext-id/', key, platform.coreId), true);
      try {
        const res = await release({ namespace: ns, blindedValue: field.blindedValue, reason: 'r' });
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
        assert.strictEqual(await platform.getCoreRow('ext-id/', key), platform.coreId, 'left for the reconcile');
      } finally {
        await platform.deleteCoreRowIfValue('ext-id/', key, platform.coreId);
      }
    });

    it('[XIDAR2] the holder\'s trail records the release (namespace and reason, no value)', async function () {
      const holder = await userWithEmail();
      const v = blinded();
      assert.strictEqual((await claim(holder, { namespace: ns, blindedValue: v })).status, 201);
      assert.strictEqual((await release({ namespace: ns, blindedValue: v, reason: 'duplicate patient file' })).status, 200);
      const row = (await auditRows(holder)).find((e) => e.content?.action === 'account.externalIds.adminRelease');
      assert.ok(row != null, 'no account.externalIds.adminRelease row');
      assert.deepStrictEqual(row.content.record, { namespace: ns, reason: 'duplicate patient file' });
      assert.ok(!JSON.stringify(row).includes(v));
    });

    it('[XIDAR3] with mail on, the holder is told (label and reason, no value); a failed send still releases', async function () {
      const restore = injectTestConfigSnapshot({ services: { email: { enabled: { externalIdReleased: true } } } });
      try {
        const holder = await userWithEmail();
        const v = blinded();
        assert.strictEqual((await claim(holder, { namespace: ns, blindedValue: v })).status, 201);
        const captured = [];
        nock(MANDRILL).post(MANDRILL_PATH).reply(200, (uri, body) => { captured.push(body); return {}; });
        const res = await release({ namespace: ns, blindedValue: v, reason: 'wrong patient' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.notified, 'mail');
        await pollUntil(async () => captured.length, (n) => n >= 1, { timeoutMs: 3000 });
        const mail = captured[0];
        assert.strictEqual(mail.template_name, 'external-id-released');
        const vars = Object.fromEntries(mail.message.global_merge_vars.map((x) => [x.name, x.content]));
        assert.strictEqual(vars.USERNAME, holder.username);
        assert.strictEqual(vars.REASON, 'wrong patient');
        assert.ok(typeof vars.NAMESPACE_LABEL === 'string' && vars.NAMESPACE_LABEL.length > 0);
        assert.ok(!JSON.stringify(mail).includes(v), 'the mail holds no value');
        // The send fails: released all the same, told 'audit-only'.
        const v2 = blinded();
        const holder2 = await userWithEmail();
        assert.strictEqual((await claim(holder2, { namespace: ns, blindedValue: v2 })).status, 201);
        nock(MANDRILL).post(MANDRILL_PATH).reply(500, {});
        const failed = await release({ namespace: ns, blindedValue: v2, reason: 'wrong patient' });
        assert.strictEqual(failed.status, 200, JSON.stringify(failed.body));
        assert.strictEqual(failed.body.notified, 'audit-only');
        assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v2 })).status, 404, 'released');
      } finally {
        restore();
        nock.cleanAll();
      }
    });

    it('[XIDAR4] nobody holds it: 404; unknown namespace, no reason, no admin key: refused, never echoing the value', async function () {
      const v = blinded();
      const none = await release({ namespace: ns, blindedValue: v, reason: 'r' });
      assert.strictEqual(none.status, 404);
      assert.ok(!JSON.stringify(none.body).includes(v));
      assert.strictEqual((await release({ namespace: 'no-such-ns', blindedValue: v, reason: 'r' })).status, 400);
      assert.strictEqual((await release({ namespace: ns, blindedValue: v })).status, 400, 'a reason is required');
      assert.strictEqual((await release({ namespace: ns, blindedValue: v, reason: 'r' }, null)).status, 404, 'admin key required');
    });

    it('[XIDAR5] held on another core: 307 to that core\'s release route', async function () {
      const { getExternalIdsService } = require('business/src/external-ids/service.ts');
      const field = await (await getExternalIdsService()).parseFlowField({ namespace: ns, blindedValue: blinded() });
      const platform = await require('platform').getPlatform();
      const key = field.tokens.nsToken + '/' + field.tokens.valueToken;
      assert.strictEqual(await platform.claimCoreRow('ext-id/', key, 'core-elsewhere'), true);
      try {
        const res = await release({ namespace: ns, blindedValue: field.blindedValue, reason: 'r' });
        assert.strictEqual(res.status, 307, JSON.stringify(res.body));
        const server = platform.coreIdToUrl('core-elsewhere').replace(/\/?$/, '/');
        assert.strictEqual(res.headers.location, server + 'system/admin/ext-id/release');
        assert.deepStrictEqual(Object.keys(res.body).filter((k) => k !== 'meta'), ['server']);
      } finally {
        await platform.deleteCoreRowIfValue('ext-id/', key, 'core-elsewhere');
      }
    });
  });

  describe('[XIDU] lookup', function () {
    // An id held by an account of this core, claimed here rather than by [XIDC].
    let held;
    before(async function () {
      await ensureNamespace();
      const holder = await makeUser();
      held = blinded();
      assert.strictEqual((await claim(holder, { namespace: ns, blindedValue: held })).status, 201);
    });

    it('[XIDLU1] POST answers the core URL; unclaimed and unknown namespace are the same 404; GET is not a route', async function () {
      const res = await lookup({ namespace: ns, blindedValue: held });
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
        assert.strictEqual((await claim(users.a, { namespace: ns, blindedValue: held })).status, 409);
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
    before(ensureNamespace);

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
    it('[XIDG1] claim, refusals, malformed input, replace, release, list, lookups and the admin release log no value', async function () {
      const c = await makeUser();
      const v = blinded();
      const v2 = blinded();
      const v3 = blinded();
      const v4 = blinded();
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
        // The admin release: released (200), nobody holds it (404), held elsewhere (307).
        const adminRelease = (blindedValue) => coreRequest.post('/system/admin/ext-id/release').set('authorization', adminKey)
          .send({ namespace: ns, blindedValue, reason: 'xidg' });
        bodies.push((await claim(c, { namespace: ns, blindedValue: v3 })).body);
        bodies.push((await adminRelease(v3)).body);
        bodies.push((await adminRelease(v3)).body);
        const field = await (await require('business/src/external-ids/service.ts').getExternalIdsService()).parseFlowField({ namespace: ns, blindedValue: v4 });
        const platform = await require('platform').getPlatform();
        const key = field.tokens.nsToken + '/' + field.tokens.valueToken;
        await platform.claimCoreRow('ext-id/', key, 'core-elsewhere');
        try {
          bodies.push((await adminRelease(v4)).body);
        } finally {
          await platform.deleteCoreRowIfValue('ext-id/', key, 'core-elsewhere');
        }
      });
      assert.ok(lines.some((l) => l.name.endsWith('request-trace') && l.text.includes('/reg/ext-id/cores')),
        'the log channel delivers: the lookup is traced');
      assert.ok(lines.some((l) => l.text.includes(probe)), 'the capture sees debug lines');
      for (const secret of [v, v2, v3, v4, malformed]) {
        assert.deepStrictEqual(lines.filter((l) => l.text.includes(secret)), [], 'no log line holds a value');
      }
      const responses = JSON.stringify(bodies);
      for (const secret of [v, v2, v3, v4, malformed]) assert.ok(!responses.includes(secret), 'no response holds a value');
      const audit = await coreRequest.get(`/${c.username}/events`).set('Authorization', c.token).query({ streams: JSON.stringify([':_audit:']) });
      const auditText = JSON.stringify(audit.body);
      assert.ok(!auditText.includes(v) && !auditText.includes(v2) && !auditText.includes(malformed), 'the audit trail holds no value');
    });
  });

  describe('[XIDD] deletion', function () {
    // Self-contained: the namespace exists and holds one claimed id, whether
    // or not the tests above ran.
    before(async function () {
      await ensureNamespace();
      const holder = await makeUser();
      assert.strictEqual((await claim(holder, { namespace: ns, blindedValue: blinded() })).status, 201);
    });

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
