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

describe('[XIDF] external ids in the sign-in and registration flows (hint and forced modes)', function () {
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

    it('[XIDFA2] is refused when malformed (no value echoed) or for an unknown namespace; forced is accepted, explicit or by default', async function () {
      const bad = 'bad*' + blinded();
      const malformed = await createRequest({ externalId: { namespace: ns, blindedValue: bad } });
      assert.strictEqual(malformed.status, 400);
      assert.strictEqual(malformed.body.error.data.param, 'externalId.blindedValue');
      assert.ok(!JSON.stringify(malformed.body).includes(bad));
      const unknownNs = await createRequest({ externalId: { namespace: 'no-such-ns', blindedValue: blinded() } });
      assert.strictEqual(unknownNs.status, 400);
      assert.strictEqual(unknownNs.body.error.data.param, 'externalId.namespace');
      const forced = await createRequest({ externalId: { namespace: ns, blindedValue: blinded(), mode: 'forced' } });
      assert.strictEqual(forced.status, 201, JSON.stringify(forced.body));
      assert.deepStrictEqual(forced.body.externalId, { namespace: ns, mode: 'forced' });
      const forcedByDefault = await createRequest({ externalId: { namespace: nsForced, blindedValue: blinded() } });
      assert.strictEqual(forcedByDefault.status, 201, 'a namespace whose default mode is forced');
      assert.strictEqual(forcedByDefault.body.externalId.mode, 'forced');
      assert.strictEqual((await createRequest({ externalId: { namespace: ns, blindedValue: blinded(), mode: 'other' } })).status, 400);
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
      const acceptedPoll = await coreRequest.get('/reg/access/' + created.body.key);
      assert.strictEqual(acceptedPoll.body.externalIdDeclined, true);
      assert.ok(!('externalId' in acceptedPoll.body), 'the accepted poll carries no external id, so no value');

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

  describe('[XIDFA4] externalIdDeclined on a credential hand-off request', function () {
    let user;
    before(async function () {
      const reg = await register();
      user = { username: reg.username, token: tokenOf(reg.res.body.apiEndpoint) };
    });

    it('[XIDFA4a] kept when the server converts an inline accept into a hand-off (shape L)', async function () {
      const created = await createRequest({ credentialHandoff: 'shared-secret', externalId: { namespace: ns, blindedValue: blinded() } });
      const res = await coreRequest.post('/reg/access/' + created.body.key).send({
        status: 'ACCEPTED', username: user.username, token: user.token, apiEndpoint: 'https://' + user.username + '.pryv.me/', externalIdDeclined: true
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.handoff?.key, 'converted to a hand-off');
      assert.strictEqual(res.body.externalIdDeclined, true);
      assert.strictEqual((await coreRequest.get('/reg/access/' + created.body.key)).body.externalIdDeclined, true);
    });

    it('[XIDFA4b] kept on a hand-off the page created itself (shape H)', async function () {
      const created = await createRequest({ credentialHandoff: 'shared-secret', externalId: { namespace: ns, blindedValue: blinded() } });
      const res = await coreRequest.post('/reg/access/' + created.body.key).send({
        status: 'ACCEPTED',
        username: user.username,
        apiEndpoint: 'https://' + user.username + '.pryv.me/',
        handoff: { type: 'shared-secret', key: cuid() + '.' + 'h'.repeat(40) },
        externalIdDeclined: true
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.externalIdDeclined, true);
    });
  });

  describe('[XIDFF] forced mode: only the holder receives the credential', function () {
    let holder, other, v;

    async function account () {
      const reg = await register();
      assert.strictEqual(reg.res.status, 201, JSON.stringify(reg.res.body));
      return { username: reg.username, token: tokenOf(reg.res.body.apiEndpoint), apiEndpoint: reg.res.body.apiEndpoint };
    }

    function accept (key, who, extra = {}) {
      return coreRequest.post('/reg/access/' + key)
        .send({ status: 'ACCEPTED', username: who.username, token: who.token, apiEndpoint: who.apiEndpoint, ...extra });
    }

    async function forcedRequest (value = v, extra = {}) {
      const created = await createRequest({ externalId: { namespace: ns, blindedValue: value, mode: 'forced' }, ...extra });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      return created.body.key;
    }

    async function stillPending (key) {
      assert.strictEqual((await coreRequest.get('/reg/access/' + key)).body.status, 'NEED_SIGNIN', 'the request is unchanged');
    }

    before(async function () {
      holder = await account();
      other = await account();
      v = blinded();
      const claimed = await coreRequest.post('/' + holder.username + '/account/external-ids').set('Authorization', holder.token)
        .send({ namespace: ns, blindedValue: v });
      assert.strictEqual(claimed.status, 201, JSON.stringify(claimed.body));
    });

    it('[XIDFF1] the holder\'s inline accept is delivered', async function () {
      const key = await forcedRequest();
      const res = await accept(key, holder);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ACCEPTED');
      assert.strictEqual(res.body.token, holder.token);
    });

    it('[XIDFF2] a non-holder naming the holder with a token of their own is token-invalid, nothing delivered', async function () {
      const key = await forcedRequest();
      const res = await accept(key, { ...holder, token: other.token });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'external-id-mismatch');
      assert.deepStrictEqual(res.body.error.data, { namespace: ns, reason: 'token-invalid' });
      await stillPending(key);
    });

    // Mutation check (must make XIDFF3 fail): remove the checkForcedAcceptance
    // call in the ACCEPTED handler of routes/reg/access.ts. The page is out of
    // the loop here (a raw HTTP accept), so the guarantee is the server's.
    it('[XIDFF3] a non-holder accepting as themselves is not-holder; the request stays open for the holder', async function () {
      const key = await forcedRequest();
      const res = await accept(key, other);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'external-id-mismatch');
      assert.deepStrictEqual(res.body.error.data, { namespace: ns, reason: 'not-holder' });
      assert.ok(!JSON.stringify(res.body).includes(v), 'the answer holds no value');
      await stillPending(key);
      assert.strictEqual((await accept(key, holder)).status, 200, 'the holder can still accept');
    });

    it('[XIDFF4] an id nobody holds is not-holder too (the auth request never claims)', async function () {
      const unclaimed = blinded();
      const key = await forcedRequest(unclaimed);
      const res = await accept(key, holder);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.data.reason, 'not-holder');
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: unclaimed })).status, 404);
    });

    it('[XIDFF5] the UI hand-off and externalIdDeclined are refused on a forced request', async function () {
      const key = await forcedRequest(v, { credentialHandoff: 'shared-secret' });
      const shapeH = await coreRequest.post('/reg/access/' + key).send({
        status: 'ACCEPTED',
        username: holder.username,
        apiEndpoint: holder.apiEndpoint,
        handoff: { type: 'shared-secret', key: cuid() + '.' + 'h'.repeat(40) }
      });
      assert.strictEqual(shapeH.status, 400);
      assert.strictEqual(shapeH.body.error.id, 'invalid-parameters');
      const declined = await accept(await forcedRequest(), holder, { externalIdDeclined: true });
      assert.strictEqual(declined.status, 400);
      assert.strictEqual(declined.body.error.id, 'invalid-parameters');
      await stillPending(key);
    });

    it('[XIDFF6] a hand-off request: checked before the server creates the secret', async function () {
      const refusedKey = await forcedRequest(v, { credentialHandoff: 'shared-secret' });
      const refused = await accept(refusedKey, other);
      assert.strictEqual(refused.status, 400);
      assert.ok(refused.body.handoff == null, 'no secret for a refused accept');
      const key = await forcedRequest(v, { credentialHandoff: 'shared-secret' });
      const res = await accept(key, holder);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.handoff?.key, 'converted to a hand-off after the check');
      assert.ok(res.body.token == null, 'the token is not delivered inline');
    });

    it('[XIDFF7] a delegated grant is checked on the account it is granted on', async function () {
      const delegation = (who) => ({ isDelegatedAccess: true, controlledUsername: who.username, delegate: { username: 'carer' + cuid().slice(-6).toLowerCase() } });
      const refused = await accept(await forcedRequest(), other, { delegation: delegation(other) });
      assert.strictEqual(refused.status, 400);
      assert.strictEqual(refused.body.error.data.reason, 'not-holder');
      const ok = await accept(await forcedRequest(), holder, { delegation: delegation(holder) });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    it('[XIDFF8] not-holder refusals count in the per-address budget; token-invalid ones do not', async function () {
      for (let i = 0; i < 12; i++) {
        assert.strictEqual((await accept(await forcedRequest(), { ...holder, token: 'not-a-token-' + i })).status, 400);
      }
      for (let i = 0; i < 10; i++) {
        assert.strictEqual((await accept(await forcedRequest(), other)).status, 400, 'refusal ' + i);
      }
      const over = await accept(await forcedRequest(), holder);
      assert.strictEqual(over.status, 429, JSON.stringify(over.body));
      assert.strictEqual(over.body.error.id, 'too-many-attempts');
      await extIdLookupBudget.clear();
      assert.strictEqual((await accept(await forcedRequest(), holder)).status, 200);
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
        // A refused forced accept (another account than the holder).
        const forced = await createRequest({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
        const second = await register();
        await coreRequest.post('/reg/access/' + forced.body.key).send({
          status: 'ACCEPTED', username: second.username, token: tokenOf(second.res.body.apiEndpoint), apiEndpoint: second.res.body.apiEndpoint
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
      const refused = await register({ externalId: { namespace: ns, blindedValue: v, mode: 'other' } });
      assert.strictEqual(refused.res.status, 400);
      assert.strictEqual(refused.res.body.error.data.param, 'externalId.mode');
      // The username is still free: nothing was reserved.
      const check = await coreRequest.get('/reg/' + refused.username + '/check_username');
      assert.strictEqual(check.body.reserved, false, JSON.stringify(check.body));
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v })).status, 404);
      const malformed = await register({ externalId: { namespace: ns, blindedValue: 'short' } });
      assert.strictEqual(malformed.res.status, 400);
      assert.ok(!JSON.stringify(malformed.res.body).includes('short"'));
    });

    // Mutation check (must make XIDFR5 fail): remove the releaseRegistrationClaim
    // call in Registration.createUser's catch.
    it('[XIDFR5] an account write that fails after the claim gives the id and the name back', async function () {
      const { getUsersRepository } = require('business/src/users/index.ts');
      const repo = await getUsersRepository();
      const original = repo.insertOne;
      // A failing insert gives its own reservations back (as insertOne does), then throws.
      repo.insertOne = async (user) => {
        await repo.compensateFailedInsert(user);
        throw new Error('xidfr5 simulated write failure');
      };
      const v = blinded();
      let failed;
      try {
        failed = await register({ externalId: { namespace: ns, blindedValue: v } });
      } finally {
        repo.insertOne = original;
      }
      assert.strictEqual(failed.res.status, 500);
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v })).status, 404, 'the id is given back');
      const again = await register({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(again.res.status, 201, JSON.stringify(again.res.body));
      assert.strictEqual(again.res.body.externalIdLinked, true);
    });

    // Mutation check (must make XIDFR6 fail): remove the compensateFailedInsert
    // call in the catch around reserveAtRegistration in Registration.createUser.
    it('[XIDFR6] a claim that throws gives back what the registration reserved', async function () {
      const { getExternalIdsService } = require('business/src/external-ids/service.ts');
      const service = await getExternalIdsService();
      const original = service.reserveAtRegistration;
      service.reserveAtRegistration = async () => { throw new Error('xidfr6 simulated platform failure'); };
      let failed;
      try {
        failed = await register({ externalId: { namespace: ns, blindedValue: blinded() } });
      } finally {
        service.reserveAtRegistration = original;
      }
      assert.strictEqual(failed.res.status, 500);
      // The platform's unique-email row reserved by the registration is gone.
      const platform = await require('platform').getPlatform();
      assert.strictEqual(await platform.getUsersUniqueField('email', failed.username + '@xidf.example.com'), null, 'the email reservation is given back');
    });

    // Mutation check (must make XIDFR7 fail): remove the forced `isClaimed`
    // pre-check in Registration.validateOnPlatform. An id held on this core is
    // then claimed "again" (the platform row is this core's), the account is
    // written and the answer is externalIdLinked: false instead of a refusal.
    it('[XIDFR7] forced: an id held by another account refuses the registration (409) before anything is reserved', async function () {
      const v = blinded();
      const first = await register({ externalId: { namespace: ns, blindedValue: v } });
      assert.strictEqual(first.res.body.externalIdLinked, true);
      const forced = await register({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
      assert.strictEqual(forced.res.status, 409, JSON.stringify(forced.res.body));
      assert.strictEqual(forced.res.body.error.id, 'external-id-already-claimed');
      assert.deepStrictEqual(forced.res.body.error.data, { namespace: ns, reason: 'value-taken' });
      assert.ok(!JSON.stringify(forced.res.body).includes(v));
      const check = await coreRequest.get('/reg/' + forced.username + '/check_username');
      assert.strictEqual(check.body.reserved, false, 'the username was not reserved');
    });

    it('[XIDFR8] forced: an id nobody holds is claimed and linked (externalIdLinked: true)', async function () {
      const v = blinded();
      const { res } = await register({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.externalIdLinked, true);
      assert.strictEqual((await coreRequest.post('/reg/ext-id/cores').send({ namespace: ns, blindedValue: v })).status, 200);
    });

    // Mutation check (must make XIDFR9 fail): remove the forced refusal after
    // reserveAtRegistration in Registration.createUser (the account would then be
    // written unlinked).
    it('[XIDFR9] forced: an id taken by another core between the check and the claim is a 409 with everything given back', async function () {
      const { getExternalIdsService } = require('business/src/external-ids/service.ts');
      const service = await getExternalIdsService();
      const v = blinded();
      const field = await service.parseFlowField({ namespace: ns, blindedValue: v, mode: 'forced' });
      const platform = await require('platform').getPlatform();
      assert.strictEqual(await platform.claimCoreRow('ext-id/', field.tokens.nsToken + '/' + field.tokens.valueToken, 'core-elsewhere'), true);
      const original = service.isClaimed;
      service.isClaimed = async () => false; // the race: the pre-check saw nothing
      let race;
      try {
        race = await register({ externalId: { namespace: ns, blindedValue: v, mode: 'forced' } });
      } finally {
        service.isClaimed = original;
        await platform.deleteCoreRowIfValue('ext-id/', field.tokens.nsToken + '/' + field.tokens.valueToken, 'core-elsewhere');
      }
      assert.strictEqual(race.res.status, 409, JSON.stringify(race.res.body));
      assert.strictEqual(race.res.body.error.id, 'external-id-already-claimed');
      const check = await coreRequest.get('/reg/' + race.username + '/check_username');
      assert.strictEqual(check.body.reserved, false, 'the username is given back');
      assert.strictEqual(await platform.getUsersUniqueField('email', race.username + '@xidf.example.com'), null, 'the email is given back');
    });

    it('[XIDFR4] a registration without an external id answers no externalIdLinked', async function () {
      const { res } = await register();
      assert.strictEqual(res.status, 201);
      assert.ok(!('externalIdLinked' in res.body));
    });
  });
});
