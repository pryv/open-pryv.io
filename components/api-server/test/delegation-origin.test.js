/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The `origin` of a delegation relationship (in-process integration, against
 * the configured storage engine).
 *
 * Both listings (`GET /{username}/delegations/controlled` on the delegate,
 * `GET /{username}/delegations/delegates` on the controlled account) say how the
 * relationship was made: `created` (the delegate created the account) or
 * `attached` (the account invited an existing delegate). The core sets it; a
 * client-sent `origin` is ignored. Records stored before the field existed
 * are listed with the rule `requestedAt === activatedAt` -> `created`.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[DLOI] delegation relationship origin (in-process integration)', function () {
  this.timeout(60_000);

  let fixtures, usersRepository, delegation, mall;

  before(async function () {
    await initTests();
    await initCore();
    const globalAny = global;
    await require('api-server/src/methods/delegations.ts').default(globalAny.app.api);
    fixtures = getNewFixture();
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    delegation = require('delegation');
    mall = await require('api-server/src/methods/helpers/cmcMall.ts').buildMallForCmc();
  });

  const createdKids = [];
  after(async function () {
    for (const kid of createdKids) {
      try {
        const kidId = await usersRepository.getUserIdForUsername(kid);
        if (kidId != null) await usersRepository.deleteOne(kidId, kid);
      } catch (_e) { /* best-effort */ }
    }
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function makeActor (prefix) {
    const username = prefix + '-' + cuid().slice(-8);
    const token = cuid();
    const u = await fixtures.user(username);
    await u.access({ token, type: 'personal' });
    await u.session(token);
    const userId = await usersRepository.getUserIdForUsername(username);
    return { username, token, userId, delegationsPath: '/' + username + '/delegations' };
  }

  async function listControlled (actor, token = actor.token) {
    const res = await coreRequest.get(actor.delegationsPath + '/controlled').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.controlled;
  }
  async function listDelegates (actor, token = actor.token) {
    const res = await coreRequest.get(actor.delegationsPath + '/delegates').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.delegates;
  }

  it('[DLOI1] an account created by its delegate is listed "created" on both sides, whatever the client sends', async function () {
    const parent = await makeActor('dlo-parent');
    const kid = 'dlo-kid-' + cuid().slice(-8);
    createdKids.push(kid);
    const res = await coreRequest.post(parent.delegationsPath + '/controlled')
      .set('Authorization', parent.token)
      .send({ username: kid, origin: 'attached' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const mine = (await listControlled(parent)).find((c) => c.controlled.username === kid);
    assert.strictEqual(mine.origin, 'created');

    // The kid's own view, through the delegate PAT (the kid has no password).
    const tok = await coreRequest.post(parent.delegationsPath + '/controlled/' + kid + '/token')
      .set('Authorization', parent.token).send({});
    assert.strictEqual(tok.status, 200, JSON.stringify(tok.body));
    const theirs = (await listDelegates({ delegationsPath: '/' + kid + '/delegations' }, tok.body.token))
      .find((d) => d.delegate.username === parent.username);
    assert.strictEqual(theirs.origin, 'created');
  });

  it('[DLOI2] an account that invited an existing delegate is listed "attached" on both sides, before and after the accept', async function () {
    const owner = await makeActor('dlo-owner');
    const helper = await makeActor('dlo-helper');
    const req = await coreRequest.post(owner.delegationsPath + '/attach-request')
      .set('Authorization', owner.token).send({ delegateUsername: helper.username, origin: 'created' });
    assert.strictEqual(req.status, 201, JSON.stringify(req.body));
    assert.strictEqual((await listDelegates(owner))[0].origin, 'attached');
    assert.strictEqual((await listControlled(helper))[0].origin, 'attached');

    const acc = await coreRequest.post(helper.delegationsPath + '/controlled/' + owner.username + '/accept')
      .set('Authorization', helper.token).send({});
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
    const delegates = await listDelegates(owner);
    const controlled = await listControlled(helper);
    assert.strictEqual(delegates[0].status, 'active');
    assert.strictEqual(delegates[0].origin, 'attached');
    assert.strictEqual(controlled[0].status, 'active');
    assert.strictEqual(controlled[0].origin, 'attached');
  });

  it('[DLOI3] records stored before the origin existed are listed with the rule, read back from the storage engine', async function () {
    const b = await makeActor('dlo-legacy-b');
    const a = await makeActor('dlo-legacy-a');
    const t = Math.floor(Date.now() / 1000) - 3600;
    const now = () => Date.now() / 1000;
    const ref = (username) => ({ username, hostSlug: 'legacy' });
    await delegation.store.createAnchor(mall, b.userId, { relId: cuid(), delegate: ref('lg-created'), status: 'active', requestedAt: t, activatedAt: t }, now);
    await delegation.store.createAnchor(mall, b.userId, { relId: cuid(), delegate: ref('lg-attached'), status: 'active', requestedAt: t, activatedAt: t + 42 }, now);
    await delegation.store.createAnchor(mall, b.userId, { relId: cuid(), delegate: ref('lg-invite'), status: 'invite', requestedAt: t }, now);
    await delegation.store.createMirror(mall, a.userId, { relId: cuid(), controlled: ref('lg-c-created'), status: 'active', requestedAt: t, activatedAt: t }, now);
    await delegation.store.createMirror(mall, a.userId, { relId: cuid(), controlled: ref('lg-c-attached'), status: 'stale', requestedAt: t, activatedAt: t + 1 }, now);

    const byName = (list, side) => Object.fromEntries(list.map((x) => [x[side].username, x.origin]));
    assert.deepStrictEqual(byName(await listDelegates(b), 'delegate'), {
      'lg-created': 'created',
      'lg-attached': 'attached',
      'lg-invite': 'attached'
    });
    assert.deepStrictEqual(byName(await listControlled(a), 'controlled'), {
      'lg-c-created': 'created',
      'lg-c-attached': 'attached'
    });
  });

  it('[DLOI4] a client cannot write a delegation record (and so cannot set its origin)', async function () {
    const u = await makeActor('dlo-forge');
    const res = await coreRequest.post('/' + u.username + '/events').set('Authorization', u.token).send({
      streamIds: [delegation.delegatesStreamId()],
      type: delegation.ET_ANCHOR,
      content: { relId: 'forged', delegate: { username: 'x', hostSlug: 'y' }, status: 'active', origin: 'created', requestedAt: 1, activatedAt: 1 }
    });
    assert.ok(res.status >= 400 && res.status < 500, 'refused: ' + res.status + ' ' + JSON.stringify(res.body));
    assert.deepStrictEqual(await listDelegates(u), []);
  });
});
