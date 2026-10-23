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
const accessState = require('../src/routes/reg/accessState.ts');
const { extIdLookupBudget } = require('../src/routes/reg/extIdLookupBudget.ts');

function blinded () {
  return crypto.randomBytes(32).toString('base64url');
}

const PERMISSIONS = [{ streamId: 'diary', level: 'read' }];

describe('[XIDF] external ids in the sign-in and registration flows (hint mode)', function () {
  this.timeout(30000);
  let fixtures, adminKey, ns, nsForced;

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.extIdNamespaces.set')) {
      await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    }
    adminKey = (await getConfig()).get('auth:adminAccessKey');
    fixtures = getNewFixture();
    ns = 'flows-' + cuid().slice(-8).toLowerCase();
    nsForced = 'flowsf-' + cuid().slice(-8).toLowerCase();
    assert.strictEqual((await coreRequest.put('/system/admin/ext-id-ns/' + ns).set('authorization', adminKey).send({ label: 'Clinic EHR' })).status, 201);
    assert.strictEqual((await coreRequest.put('/system/admin/ext-id-ns/' + nsForced).set('authorization', adminKey).send({ defaultMode: 'forced' })).status, 201);
  });

  afterEach(async function () {
    await extIdLookupBudget.clear();
  });

  after(async function () {
    await accessState.clear();
    await fixtures.context.cleanEverything();
  });

  function createRequest (extra) {
    return coreRequest.post('/reg/access').send({ requestingAppId: 'test-xidf', requestedPermissions: PERMISSIONS, ...extra });
  }

  function register (extra = {}) {
    const username = 'xidf' + cuid().toLowerCase().slice(1, 12);
    return coreRequest.post('/users').send({
      appId: 'test-xidf',
      username,
      password: 'testpassw0rd',
      email: username + '@xidf.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en',
      ...extra
    }).then((res) => ({ res, username }));
  }

  function tokenOf (apiEndpoint) {
    return new URL(apiEndpoint).username;
  }

  describe('[XIDFA] auth request', function () {
    it('[XIDFA1] carries the external id: echoed without the value, polled with the label and the value', async function () {
      const v = blinded();
      const res = await createRequest({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.externalId, { namespace: ns, mode: 'hint' });
      assert.ok(!JSON.stringify(res.body).includes(v), 'the creation answer holds no value');
      const poll = await coreRequest.get('/reg/access/' + res.body.key);
      assert.deepStrictEqual(poll.body.externalId, { namespace: ns, blindedValue: v, mode: 'hint', label: 'Clinic EHR' });
    });

    it('[XIDFA2] is refused when malformed (no value echoed), for an unknown namespace, and in forced mode for now', async function () {
      const bad = 'bad*' + blinded();
      const malformed = await createRequest({ externalId: { namespace: ns, blindedValue: bad } });
      assert.strictEqual(malformed.status, 400);
      assert.strictEqual(malformed.body.error.data.param, 'externalId.blindedValue');
      assert.ok(!JSON.stringify(malformed.body).includes(bad));
      const unknownNs = await createRequest({ externalId: { namespace: 'no-such-ns', blindedValue: blinded() } });
      assert.strictEqual(unknownNs.status, 400);
      assert.strictEqual(unknownNs.body.error.data.param, 'externalId.namespace');
      const forced = await createRequest({ externalId: { namespace: ns, blindedValue: blinded(), mode: 'forced' } });
      assert.strictEqual(forced.status, 400);
      assert.strictEqual(forced.body.error.data.reason, 'forced-mode-not-available');
      const forcedByDefault = await createRequest({ externalId: { namespace: nsForced, blindedValue: blinded() } });
      assert.strictEqual(forcedByDefault.status, 400, 'a namespace whose default mode is forced');
      assert.strictEqual(forcedByDefault.body.error.data.reason, 'forced-mode-not-available');
      assert.strictEqual((await createRequest({ externalId: 'not an object' })).status, 400);
    });

    it('[XIDFA3] an accepted request carries externalIdDeclined when the user declined; otherwise refused', async function () {
      const { username, res: reg } = await register();
      assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
      const token = tokenOf(reg.body.apiEndpoint);
      const created = await createRequest({ externalId: { namespace: ns, blindedValue: blinded() } });
      const accepted = await coreRequest.post('/reg/access/' + created.body.key)
        .send({ status: 'ACCEPTED', username, token, apiEndpoint: reg.body.apiEndpoint, externalIdDeclined: true });
      assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
      assert.strictEqual(accepted.body.externalIdDeclined, true);
      assert.strictEqual((await coreRequest.get('/reg/access/' + created.body.key)).body.externalIdDeclined, true);

      const plain = await createRequest({});
      const wrong = await coreRequest.post('/reg/access/' + plain.body.key)
        .send({ status: 'ACCEPTED', username, token, apiEndpoint: reg.body.apiEndpoint, externalIdDeclined: true });
      assert.strictEqual(wrong.status, 400, 'no external id on the request');
      const withId = await createRequest({ externalId: { namespace: ns, blindedValue: blinded() } });
      assert.strictEqual((await coreRequest.post('/reg/access/' + withId.body.key).send({ status: 'REFUSED', externalIdDeclined: true })).status, 400);
      assert.strictEqual((await coreRequest.post('/reg/access/' + withId.body.key)
        .send({ status: 'ACCEPTED', username, token, apiEndpoint: reg.body.apiEndpoint, externalIdDeclined: 'yes' })).status, 400);
    });
  });

  describe('[XIDFG] the blinded value is never logged by the flows', function () {
    async function captureLogs (fn) {
      const { inspect } = require('node:util');
      const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
      const original = proto.log;
      const lines = [];
      proto.log = function (level, msg, ...rest) {
        lines.push({ name: this._name(), text: String(msg) + (rest.length > 0 ? ' ' + inspect(rest, { depth: 8 }) : '') });
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

    it('[XIDFG1] auth request (create, poll, accept), registration (linked, unlinked, refused) log no value', async function () {
      const v = blinded();
      const malformed = 'bad*' + blinded();
      const lines = await captureLogs(async () => {
        const created = await createRequest({ externalId: { namespace: ns, blindedValue: v } });
        await coreRequest.get('/reg/access/' + created.body.key);
        await createRequest({ externalId: { namespace: ns, blindedValue: malformed } });
        const first = await register({ externalId: { namespace: ns, blindedValue: v } });
        await register({ externalId: { namespace: ns, blindedValue: v } });
        await register({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
        await register({ externalId: { namespace: ns, blindedValue: malformed } });
        await coreRequest.post('/reg/access/' + created.body.key).send({
          status: 'ACCEPTED', username: first.username, token: tokenOf(first.res.body.apiEndpoint), apiEndpoint: first.res.body.apiEndpoint, externalIdDeclined: true
        });
      });
      assert.ok(lines.some((l) => l.name.endsWith('request-trace') && l.text.includes('/reg/access')), 'the log channel delivers');
      for (const secret of [v, malformed]) {
        assert.deepStrictEqual(lines.filter((l) => l.text.includes(secret)), [], 'no log line holds a value');
      }
    });
  });

  describe('[XIDFR] registration', function () {
    it('[XIDFR1] an unclaimed id is linked to the new account (externalIdLinked: true)', async function () {
      const v = blinded();
      const { res } = await register({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.externalIdLinked, true);
      assert.ok(!JSON.stringify(res.body).includes(v));
      const list = await coreRequest.get('/' + res.body.username + '/account/external-ids').set('Authorization', tokenOf(res.body.apiEndpoint));
      assert.deepStrictEqual(list.body.externalIds.map((x) => x.namespace), [ns]);
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v })).status, 200);
    });

    it('[XIDFR2] a held id leaves the new account unlinked (externalIdLinked: false), the holder keeps it', async function () {
      const v = blinded();
      const first = await register({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(first.res.body.externalIdLinked, true);
      const second = await register({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(second.res.status, 201, JSON.stringify(second.res.body));
      assert.strictEqual(second.res.body.externalIdLinked, false);
      const list2 = await coreRequest.get('/' + second.username + '/account/external-ids').set('Authorization', tokenOf(second.res.body.apiEndpoint));
      assert.deepStrictEqual(list2.body.externalIds, []);
      const list1 = await coreRequest.get('/' + first.username + '/account/external-ids').set('Authorization', tokenOf(first.res.body.apiEndpoint));
      assert.deepStrictEqual(list1.body.externalIds.map((x) => x.namespace), [ns]);
    });

    it('[XIDFR3] a refused external id refuses the registration before anything is reserved', async function () {
      const v = blinded();
      const forced = await register({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
      assert.strictEqual(forced.res.status, 400);
      assert.strictEqual(forced.res.body.error.data.reason, 'forced-mode-not-available');
      // The username is still free: nothing was reserved.
      const check = await coreRequest.get('/reg/' + forced.username + '/check_username');
      assert.strictEqual(check.body.reserved, false, JSON.stringify(check.body));
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v })).status, 404);
      const malformed = await register({ externalId: { namespace: ns, blindedValue: 'short' } });
      assert.strictEqual(malformed.res.status, 400);
      assert.ok(!JSON.stringify(malformed.res.body).includes('short"'));
    });

    it('[XIDFR4] a registration without an external id answers no externalIdLinked', async function () {
      const { res } = await register();
      assert.strictEqual(res.status, 201);
      assert.ok(!('externalIdLinked' in res.body));
    });
  });
});
