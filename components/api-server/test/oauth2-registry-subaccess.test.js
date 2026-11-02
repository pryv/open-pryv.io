/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OACR] The `accessCreation` feature permission: `forbidden` bars an access
 * from creating accesses and webhooks (it still manages what it created);
 * registry grants forbid it unless the client row allows it.
 *
 * [OSUB] What an OAuth session creates belongs to the session's grant: the
 * shared access is stamped with the grant, narrowed when the grant changes
 * (deleted when left with no reach), and deleted with the grant, whichever
 * session created it and whether that session is still live.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid, withInjectedConfig */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot } from 'test-helpers';
import { getStorageLayer } from 'storage';
import { getUsersRepository } from 'business/src/users/index.ts';
import { fromCallback } from 'utils';

const REDIRECT_URI = 'https://app.subaccess.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';

// Toy grammar: `read/<s>`, `write/<s>` give one stream a level; `ctx/pseudo`
// asks for a pseudonym; the user may untick entries.
const LEVEL_OF = { read: 'read', write: 'contribute' };
const toyExtension = {
  apiVersion: 1,
  name: 'toy-subaccess',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t.startsWith('ctx/')) continue;
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(slash + 1), level });
      }
      return { ok: true, tokens, offer: { permissions, allowUserChoice: true, randomAlias: tokens.includes('ctx/pseudo') } };
    },
    echo ({ permissions, requestedTokens, aliased }) {
      const has = (s, levels) => permissions.some((p) => p.streamId === s && levels.includes(p.level));
      const echoed = requestedTokens.filter((t) => {
        if (t.startsWith('ctx/')) return t !== 'ctx/pseudo';
        const [kind, s] = t.split('/');
        return kind === 'read' ? has(s, ['read', 'contribute']) : has(s, ['contribute']);
      });
      return aliased ? [...echoed, 'ctx/pseudo'] : echoed;
    },
  },
};

const SCOPE = ['read/a', 'read/b', 'read/c', 'write/a', 'write/b', 'ctx/pseudo'];
// The stream tree of every test user: `a1` is a child of `a`.
const PARENT = { a1: 'a' };
const COVERS = { read: ['read', 'contribute', 'manage'], contribute: ['contribute', 'manage'], 'create-only': ['create-only', 'contribute', 'manage'] };

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function baseOf (accessId) {
  return String(accessId).split(':')[0];
}

function streamsOf (permissions) {
  return permissions.filter((p) => p.streamId != null && !p.streamId.startsWith(':')).map((p) => p.streamId + ':' + p.level).sort();
}

function featuresOf (permissions) {
  return permissions.filter((p) => p.feature != null).map((p) => p.feature + ':' + p.setting).sort();
}

/** The level `permissions` reach `streamId` with, through the stream tree (none: null). */
function levelAt (permissions, streamId) {
  for (let s = streamId; s != null; s = PARENT[s]) {
    const own = permissions.find((p) => p.streamId === s);
    if (own != null) return own.level;
  }
  return null;
}

/** Every stream the child reaches is reached by the grant at a level covering it. */
function assertWithinGrant (child, grant, label) {
  for (const p of child.permissions.filter((e) => e.streamId != null && e.level !== 'none' && !e.streamId.startsWith(':'))) {
    const held = levelAt(grant.permissions, p.streamId);
    assert.ok(held != null && held !== 'none' && COVERS[p.level].includes(held),
      `${label}: the child holds ${p.streamId}:${p.level}, the grant ${held}: ` + JSON.stringify({ child: child.permissions, grant: grant.permissions }));
  }
}

describe('[OSUB] OAuth registry clients: what sessions create follows the grant; [OACR] accessCreation', function () {
  this.timeout(90000);

  let fixtures, restoreConfig, platformDB, openId, closedId, hooksOnlyId, bothId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    const row = {
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: SCOPE,
    };
    openId = 'Sub.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: openId, allowFeatures: ['accessCreation'] });
    closedId = 'SubC.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: closedId });
    hooksOnlyId = 'SubH.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: hooksOnlyId, allowFeatures: ['webhooks'] });
    bothId = 'SubB.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: bothId, allowFeatures: ['accessCreation', 'webhooks'] });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [openId, closedId, hooksOnlyId, bothId]) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  /** A fresh user with streams a (and its child a1), b, c, one event in each. */
  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    for (const [id, parentId] of [['a', null], ['a1', 'a'], ['b', null], ['c', null]]) {
      const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id, name: id, parentId });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      const e = await coreRequest.post('/' + username + '/events').set('Authorization', token)
        .send({ streamIds: [id], type: 'note/txt', content: id });
      assert.equal(e.status, 201, JSON.stringify(e.body));
    }
    return { username, token, userId: user.attrs.id };
  }

  /** Authorize, signed-in offer, accept (all shown entries, or `keep`) with shownDigest, exchange. */
  async function consentAndToken (who, scope, { cid = openId, keep = null } = {}) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
    assert.equal(res.status, 302, res.text);
    const state = new URL(res.headers.location).searchParams.get('state');
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const shown = o.body.offer.permissions;
    const granted = (keep == null ? shown : shown.filter(keep)).map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const a = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const code = new URL(a.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  function refresh (refreshToken, cid = openId) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  async function accesses (who, query = {}) {
    const res = await coreRequest.get('/' + who.username + '/accesses').query(query).set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function grantOf (who, cid = openId) {
    return (await accesses(who)).find((a) => a.name === 'oauth-grant:' + cid) ?? null;
  }

  async function accessById (who, id) {
    return (await accesses(who, { includeExpired: true })).find((a) => baseOf(a.id) === baseOf(id)) ?? null;
  }

  /** The session creates a shared access (`at`: the name it addresses the account by). */
  function createChild (who, sessionToken, permissions, extra = {}, at = who.username) {
    return coreRequest.post('/' + at + '/accesses').set('Authorization', sessionToken)
      .send({ type: 'shared', name: 'child-' + cuid().slice(-8), permissions, ...extra });
  }

  function readStream (who, token, streamId, at = who.username) {
    return coreRequest.get('/' + at + '/events').query({ streams: JSON.stringify([streamId]) }).set('Authorization', token);
  }

  function ownerUpdate (who, access, update) {
    return coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(access.id)).set('Authorization', who.token).send(update);
  }

  async function ownerNarrow (who, keepStreams, cid = openId) {
    const grant = await grantOf(who, cid);
    const res = await ownerUpdate(who, grant, { permissions: grant.permissions.filter((p) => p.streamId == null || keepStreams(p)) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.access;
  }

  // ---------------------------------------------------------------------
  // accessCreation
  // ---------------------------------------------------------------------

  it('[OACR1] a registry session is refused accesses.create and webhooks.create unless the client row allows accessCreation', async () => {
    const who = await newUser();
    const closed = await consentAndToken(who, 'read/a', { cid: closedId });
    const grant = await grantOf(who, closedId);
    assert.ok(featuresOf(grant.permissions).includes('accessCreation:forbidden'), JSON.stringify(grant.permissions));
    const refused = await createChild(who, closed.access_token, [{ streamId: 'a', level: 'read' }]);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /accessCreation: forbidden/);
    // Webhooks allowed on the row, access creation not: the webhook is refused too.
    const hooks = await consentAndToken(who, 'read/a', { cid: hooksOnlyId });
    const g2 = await grantOf(who, hooksOnlyId);
    assert.deepEqual(featuresOf(g2.permissions), ['accessCreation:forbidden', 'secretSharing:forbidden']);
    const hook = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', hooks.access_token)
      .send({ url: 'https://hooks.test/notify' });
    assert.equal(hook.status, 403, JSON.stringify(hook.body));
    assert.match(hook.body.error.message, /accessCreation: forbidden/);
    assert.equal((await accesses(who)).filter((a) => a.type === 'shared').length, 0);
  });

  it('[OACR2] allowed on the row: the session creates shared accesses, which inherit its restrictions', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a');
    const grant = await grantOf(who);
    assert.deepEqual(featuresOf(grant.permissions), ['secretSharing:forbidden', 'webhooks:forbidden']);
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    assert.deepEqual(featuresOf(child.body.access.permissions), ['secretSharing:forbidden', 'webhooks:forbidden']);
    assert.equal((await readStream(who, child.body.access.token, 'a')).status, 200);
  });

  it('[OACR3] an app forbidden accessCreation later still manages the accesses it created; the owner still updates it', async () => {
    const who = await newUser();
    const app = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ type: 'app', name: 'acr-app', permissions: [{ streamId: 'a', level: 'contribute' }, { streamId: 'b', level: 'read' }] });
    assert.equal(app.status, 201, JSON.stringify(app.body));
    const child = await createChild(who, app.body.access.token, [{ streamId: 'a', level: 'contribute' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    // An access a non-OAuth app creates is not bound to any grant.
    assert.equal(child.body.access.clientData?.oauth, undefined);
    const forbid = await ownerUpdate(who, app.body.access, {
      permissions: app.body.access.permissions.concat([{ feature: 'accessCreation', setting: 'forbidden' }]),
    });
    assert.equal(forbid.status, 200, JSON.stringify(forbid.body));
    const refused = await createChild(who, app.body.access.token, [{ streamId: 'b', level: 'read' }]);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    // Its own child: narrowed by the app (scope rules only), and the
    // restriction rides along onto it.
    const upd = await coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(child.body.access.id))
      .set('Authorization', app.body.access.token).send({ permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.deepEqual(streamsOf(upd.body.access.permissions), ['a:read']);
    assert.ok(featuresOf(upd.body.access.permissions).includes('accessCreation:forbidden'));
    // The owner narrows the app: its child still fits.
    const narrow = await ownerUpdate(who, forbid.body.access, {
      permissions: [{ streamId: 'a', level: 'read' }, { feature: 'accessCreation', setting: 'forbidden' }],
    });
    assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
    const hook = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', app.body.access.token)
      .send({ url: 'https://hooks.test/notify' });
    assert.equal(hook.status, 403, JSON.stringify(hook.body));
  });

  // ---------------------------------------------------------------------
  // Sub-accesses of OAuth sessions
  // ---------------------------------------------------------------------

  it('[OSUB1] the owner narrows the grant: the child is narrowed to what the grant still reaches, its token refused on the dropped stream', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'write/a read/b');
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'contribute' }, { streamId: 'b', level: 'read' }, { streamId: 'a1', level: 'contribute' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    // The grant now reads `a` and no longer reaches `b`.
    const grant = await grantOf(who);
    const upd = await ownerUpdate(who, grant, { permissions: [{ streamId: 'a', level: 'read' }].concat(grant.permissions.filter((p) => p.feature != null)) });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const after = await accessById(who, child.body.access.id);
    // `a1` (below `a`) is kept, at the level the grant reaches it with.
    assert.deepEqual(streamsOf(after.permissions), ['a1:read', 'a:read']);
    assert.equal((await readStream(who, child.body.access.token, 'b')).status, 403);
    assert.equal((await readStream(who, child.body.access.token, 'a')).status, 200);
    // Writing on `a` is no longer allowed.
    const w = await coreRequest.post('/' + who.username + '/events').set('Authorization', child.body.access.token)
      .send({ streamIds: ['a'], type: 'note/txt', content: 'x' });
    assert.equal(w.status, 403, JSON.stringify(w.body));
    // No history row for the rewrite (the grant's update made one).
    const one = await coreRequest.get('/' + who.username + '/accesses/' + encodeURIComponent(after.id)).query({ includeHistory: true })
      .set('Authorization', who.token);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(one.body.history ?? [], []);
  });

  it('[OSUB2] a child left with no reach is deleted; the session keeps working on what is left', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a read/b');
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    await ownerNarrow(who, (p) => p.streamId === 'b');
    assert.equal(await accessById(who, child.body.access.id), null);
    assert.equal((await readStream(who, child.body.access.token, 'a')).status, 403);
    assert.equal((await readStream(who, t.access_token, 'b')).status, 200);
  });

  it('[OSUB3] a child of a session that has since expired is still narrowed (bound to the grant)', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access read/a read/b');
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    await withInjectedConfig({ oauth: { consentUrl: CONSENT_URL, refreshRetireGraceSeconds: 0 } }, async () => {
      assert.equal((await refresh(t.refresh_token)).status, 200);
    });
    assert.equal((await readStream(who, t.access_token, 'a')).status, 403, 'the creating session is retired');
    await ownerNarrow(who, (p) => p.streamId === 'a');
    const after = await accessById(who, child.body.access.id);
    assert.deepEqual(streamsOf(after.permissions), ['a:read']);
    assert.equal((await readStream(who, child.body.access.token, 'b')).status, 403);
  });

  it('[OSUB4] a child created before the binding (no stamp) is matched by its creator, an expired session of the grant, and narrowed', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access read/a read/b');
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    // Seeded as an older core wrote it: no stamp.
    const storageLayer = await getStorageLayer();
    const user = { id: who.userId, username: who.username };
    await fromCallback((cb) => storageLayer.accesses.updateOne(user, { id: baseOf(child.body.access.id) },
      { clientData: { oauth: null }, modified: Date.now() / 1000 }, cb));
    assert.equal((await accessById(who, child.body.access.id)).clientData?.oauth, undefined);
    await withInjectedConfig({ oauth: { consentUrl: CONSENT_URL, refreshRetireGraceSeconds: 0 } }, async () => {
      assert.equal((await refresh(t.refresh_token)).status, 200);
    });
    await ownerNarrow(who, (p) => p.streamId === 'b');
    const after = await accessById(who, child.body.access.id);
    assert.deepEqual(streamsOf(after.permissions), ['b:read']);
    assert.equal((await readStream(who, child.body.access.token, 'a')).status, 403);
  });

  it('[OSUB5] the grant deleted: the child of an expired session goes too, and the alias is released', async () => {
    const who = await newUser();
    const usersRepository = await getUsersRepository();
    const t = await consentAndToken(who, 'offline_access read/a ctx/pseudo');
    const grant = await grantOf(who);
    assert.equal(typeof grant.alias, 'string');
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }], {}, grant.alias);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    assert.equal(child.body.access.alias, grant.alias);
    await withInjectedConfig({ oauth: { consentUrl: CONSENT_URL, refreshRetireGraceSeconds: 0 } }, async () => {
      assert.equal((await refresh(t.refresh_token)).status, 200);
    });
    assert.equal((await readStream(who, child.body.access.token, 'a', grant.alias)).status, 200);
    assert.ok((await usersRepository.getAliasesForUserId(who.userId)).includes(grant.alias));
    const del = await coreRequest.delete('/' + who.username + '/accesses/' + encodeURIComponent(grant.id)).set('Authorization', who.token);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok((del.body.relatedDeletions ?? []).some((d) => baseOf(d.id) === baseOf(child.body.access.id)), JSON.stringify(del.body));
    assert.equal(await accessById(who, child.body.access.id), null);
    // Refused at the alias (now released: unknown there) and at the username.
    assert.equal((await readStream(who, child.body.access.token, 'a', grant.alias)).status, 404);
    assert.equal((await readStream(who, child.body.access.token, 'a')).status, 403);
    assert.equal((await usersRepository.getAliasesForUserId(who.userId)).includes(grant.alias), false);
  });

  it('[OSUB6] the stamp: refused from the body, written by the server on the row the session creates', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a');
    const grant = await grantOf(who);
    const forged = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }], { clientData: { oauth: { dataGrantId: 'elsewhere' } } });
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }], { clientData: { app: 'kept' } });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const row = await accessById(who, child.body.access.id);
    assert.deepEqual(row.clientData, { app: 'kept', oauth: { dataGrantId: baseOf(grant.id) } });
    // `createdBy` stays the session; the session still lists and manages it.
    const session = (await accesses(who)).find((a) => a.name === 'oauth:' + openId);
    assert.equal(baseOf(row.createdBy), baseOf(session.id));
    const listed = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', t.access_token);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.accesses.some((a) => baseOf(a.id) === baseOf(row.id)));
    // The owner cannot remove it.
    const strip = await ownerUpdate(who, row, { clientData: { app: 'kept', oauth: null } });
    assert.equal(strip.status, 403, JSON.stringify(strip.body));
    // An access the owner creates is not stamped.
    const own = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ type: 'shared', name: 'owner-' + cuid().slice(-6), permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.access.clientData?.oauth, undefined);
  });

  it('[OSUB7] the child never exceeds the grant across re-consents, owner updates and refreshes, and is never widened back', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'offline_access write/a read/b');
    const child = await createChild(who, t.access_token, [
      { streamId: 'a', level: 'contribute' }, { streamId: 'a1', level: 'contribute' }, { streamId: 'b', level: 'read' },
    ]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const id = child.body.access.id;
    const check = async (label) => {
      const c = await accessById(who, id);
      const g = await grantOf(who);
      if (c != null) assertWithinGrant(c, g, label);
      return c;
    };
    // Owner narrows `a` to read.
    let grant = await grantOf(who);
    let upd = await ownerUpdate(who, grant, { permissions: grant.permissions.map((p) => (p.streamId === 'a' ? { streamId: 'a', level: 'read' } : p)) });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.deepEqual(streamsOf((await check('owner narrows a')).permissions), ['a1:read', 'a:read', 'b:read']);
    // A re-consent widens the grant back: the child stays narrowed.
    await consentAndToken(who, 'write/a');
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a:contribute', 'b:read']);
    assert.deepEqual(streamsOf((await check('re-consent widens')).permissions), ['a1:read', 'a:read', 'b:read']);
    // A refresh changes nothing for it.
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(streamsOf((await check('refresh')).permissions), ['a1:read', 'a:read', 'b:read']);
    // The owner masks `a1` under `a`: the child keeps `a`, `a1` is masked.
    grant = await grantOf(who);
    upd = await ownerUpdate(who, grant, { permissions: grant.permissions.concat([{ streamId: 'a1', level: 'none' }]) });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const masked = await check('owner masks a1');
    assert.deepEqual(streamsOf(masked.permissions), ['a1:none', 'a:read', 'b:read']);
    assert.equal((await readStream(who, child.body.access.token, 'a1')).status, 403);
    // A re-consent that keeps only `b` (the grant keeps the owner's mask):
    // the child keeps `b` and the mask.
    await consentAndToken(who, 'read/b', { keep: (p) => p.streamId === 'b' || p.feature != null });
    assert.deepEqual(streamsOf((await grantOf(who)).permissions), ['a1:none', 'b:read']);
    assert.deepEqual(streamsOf((await check('re-consent keeps b')).permissions), ['a1:none', 'b:read']);
    // Then only `c`: nothing left for the child, it is deleted.
    await consentAndToken(who, 'read/c', { keep: (p) => p.streamId === 'c' || p.feature != null });
    assert.equal(await check('re-consent keeps c'), null);
  });

  it('[OACR4] a session forbidden accessCreation cannot request a capability (a minted access handed on)', async () => {
    const who = await newUser();
    const capabilityRequest = {
      streamIds: ['a'],
      type: 'consent/request-cmc',
      content: {
        to: null,
        capabilityRequested: true,
        request: {
          title: { en: 'Example consent' },
          description: { en: 'Share data.' },
          consent: { en: 'I agree.' },
          permissions: [{ streamId: 'a', level: 'read' }],
        },
      },
    };
    const closed = await consentAndToken(who, 'write/a', { cid: closedId });
    const refused = await coreRequest.post('/' + who.username + '/events').set('Authorization', closed.access_token).send(capabilityRequest);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /accessCreation: forbidden/);
    assert.equal((await accesses(who)).some((a) => String(a.name).startsWith('__cmc-cap-')), false);
    // The same request without the capability is a plain event write.
    const plain = await coreRequest.post('/' + who.username + '/events').set('Authorization', closed.access_token)
      .send({ ...capabilityRequest, content: { ...capabilityRequest.content, capabilityRequested: false } });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
  });

  it('[OSUB8] the grant\'s forbids reach an existing child; another grant\'s change leaves it alone', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a', { cid: bothId });
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    assert.equal(featuresOf(child.body.access.permissions).includes('webhooks:forbidden'), false);
    const before = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', child.body.access.token)
      .send({ url: 'https://hooks.test/before' });
    assert.equal(before.status, 201, JSON.stringify(before.body));
    // Another client's grant of the same user changes: nothing happens to this child.
    await consentAndToken(who, 'read/a read/b');
    await ownerNarrow(who, (p) => p.streamId === 'a');
    assert.deepEqual((await accessById(who, child.body.access.id)).permissions, child.body.access.permissions);
    // The owner forbids webhooks and access creation on this child's grant.
    const grant = await grantOf(who, bothId);
    const upd = await ownerUpdate(who, grant, {
      permissions: grant.permissions.concat([{ feature: 'webhooks', setting: 'forbidden' }, { feature: 'accessCreation', setting: 'forbidden' }]),
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const after = await accessById(who, child.body.access.id);
    assert.ok(featuresOf(after.permissions).includes('webhooks:forbidden'), JSON.stringify(after.permissions));
    assert.ok(featuresOf(after.permissions).includes('accessCreation:forbidden'), JSON.stringify(after.permissions));
    assert.deepEqual(streamsOf(after.permissions), ['a:read']);
    const refused = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', child.body.access.token)
      .send({ url: 'https://hooks.test/after' });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  });

  it('[OSUB9] the session edits its child\'s clientData key by key, never wipes the binding; the child stays bound', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a read/b');
    const grant = await grantOf(who);
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }], { clientData: { app: 'v1' } });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const put = (body) => coreRequest.put('/' + who.username + '/accesses/' + encodeURIComponent(child.body.access.id))
      .set('Authorization', t.access_token).send(body);
    const wiped = await put({ clientData: null });
    assert.equal(wiped.status, 403, JSON.stringify(wiped.body));
    const edited = await put({ clientData: { app: 'v2' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const row = await accessById(who, child.body.access.id);
    assert.deepEqual(row.clientData, { app: 'v2', oauth: { dataGrantId: baseOf(grant.id) } });
    await ownerNarrow(who, (p) => p.streamId === 'a');
    assert.deepEqual(streamsOf((await accessById(who, child.body.access.id)).permissions), ['a:read']);
  });

  it('[OSUB10] the webhooks of a narrowed session and of a narrowed child lose the scopes they no longer reach', async () => {
    const who = await newUser();
    const t = await consentAndToken(who, 'read/a read/b', { cid: bothId });
    const scopes = { a: { kind: 'events', query: { streams: ['a'] } }, b: { kind: 'events', query: { streams: ['b'] } } };
    const sessionHook = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', t.access_token)
      .send({ url: 'https://hooks.test/session', scopes });
    assert.equal(sessionHook.status, 201, JSON.stringify(sessionHook.body));
    const child = await createChild(who, t.access_token, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const childHook = await coreRequest.post('/' + who.username + '/webhooks').set('Authorization', child.body.access.token)
      .send({ url: 'https://hooks.test/child', scopes: { b: scopes.b } });
    assert.equal(childHook.status, 201, JSON.stringify(childHook.body));
    await ownerNarrow(who, (p) => p.streamId === 'a', bothId);
    const hookOf = async (id) => {
      const res = await coreRequest.get('/' + who.username + '/webhooks/' + id).set('Authorization', who.token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.webhook;
    };
    const s = await hookOf(sessionHook.body.webhook.id);
    assert.deepEqual(Object.keys(s.scopes), ['a']);
    assert.equal(s.state, 'active');
    const c = await hookOf(childHook.body.webhook.id);
    assert.deepEqual(c.scopes, {});
    assert.equal(c.state, 'inactive');
  });
});
