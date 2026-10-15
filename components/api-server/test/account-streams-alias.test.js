/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account streams through a store-prefixed spelling of their id.
 *
 * [ASA] covers: the account-field guards (the primary-email refusal, the
 * non-editable and hidden fields, the permission caps) judge the canonical id,
 * so `:account::system:email`, `:local::system:email`, `:account:<field>` and
 * nested prefixes behave exactly like the canonical `:system:email` /
 * `:_system:<field>`; events create / update / delete and accesses create /
 * update.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

describe('[ASA] account streams through store-prefixed ids', function () {
  let fixtures, username, token, email, appToken;
  const eventsPath = () => '/' + username + '/events';
  const accessesPath = () => '/' + username + '/accesses';

  const EMAIL_ALIASES = [':account::system:email', ':local::system:email', ':local::account::system:email', ':account::local::system:email'];

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    token = cuid();
    email = username + '@asa.example.com';
    const user = await fixtures.user(username, { email });
    await user.access({ token, type: 'personal' });
    await user.session(token);
    // A consented app grant on the email field, the level an owner would
    // plausibly give (contribute).
    appToken = cuid();
    const acc = await coreRequest.post(accessesPath()).set('Authorization', token)
      .send({ type: 'app', name: 'asa-app-' + cuid().slice(-6), token: appToken, permissions: [{ streamId: ':system:email', level: 'contribute' }] });
    assert.strictEqual(acc.status, 201, JSON.stringify(acc.body));
  });

  after(async function () {
    if (fixtures != null) { try { await fixtures.clean(); } catch (_e) { /* best-effort */ } }
  });

  async function currentEmail () {
    const res = await coreRequest.get('/' + username + '/account').set('Authorization', token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.account.email;
  }

  it('[ASA1] an app with contribute on the email field cannot change the primary email through any spelling of the stream id', async function () {
    const canonical = await coreRequest.post(eventsPath()).set('Authorization', appToken)
      .send({ streamIds: [':system:email'], type: 'email/string', content: 'attacker@asa.example.com' });
    assert.strictEqual(canonical.status, 400, JSON.stringify(canonical.body));
    assert.strictEqual(canonical.body?.error?.id, 'invalid-operation');
    for (const streamId of EMAIL_ALIASES) {
      const res = await coreRequest.post(eventsPath()).set('Authorization', appToken)
        .send({ streamIds: [streamId], type: 'email/string', content: 'attacker@asa.example.com' });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
      assert.strictEqual(res.body?.error?.message, canonical.body.error.message, streamId + ': same refusal as the canonical id');
    }
    // The owner's personal token is refused the same way (account.update is the one writer).
    const personal = await coreRequest.post(eventsPath()).set('Authorization', token)
      .send({ streamIds: [':account::system:email'], type: 'email/string', content: 'owner-forged@asa.example.com' });
    assert.strictEqual(personal.status, 400, JSON.stringify(personal.body));
    assert.strictEqual(await currentEmail(), email, 'the primary email is unchanged');
  });

  it('[ASA2] a non-editable or hidden account field cannot be written through a store-prefixed id, nor a bare field through :account:', async function () {
    const canonical = await coreRequest.post(eventsPath()).set('Authorization', token)
      .send({ streamIds: [':_system:appId'], type: 'identifier/string', content: 'forged' });
    assert.strictEqual(canonical.status, 400, JSON.stringify(canonical.body));
    for (const streamId of [':account::_system:appId', ':local::_system:appId', ':account::_system:invitationToken', ':account::_system:referer']) {
      const res = await coreRequest.post(eventsPath()).set('Authorization', token)
        .send({ streamIds: [streamId], type: 'identifier/string', content: 'forged' });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
      assert.strictEqual(res.body?.error?.message, canonical.body.error.message, streamId + ': same refusal as the canonical id');
    }
    // A bare field name through the account store prefix has no canonical
    // spelling: refused as an unknown stream, never written.
    for (const streamId of [':account:appId', ':account:email', ':account:language', ':account:']) {
      const res = await coreRequest.post(eventsPath()).set('Authorization', token)
        .send({ streamIds: [streamId], type: 'note/txt', content: 'forged' });
      assert.notStrictEqual(res.status, 201, streamId + ' must not be admitted: ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'unknown-referenced-resource', streamId + ': ' + JSON.stringify(res.body));
    }
    assert.strictEqual(await currentEmail(), email);
  });

  it('[ASA3] a store-prefixed account stream in an access permission is judged, and stored, as the canonical id', async function () {
    // Too high a level on the email field: refused through every spelling.
    for (const streamId of [':system:email', ...EMAIL_ALIASES]) {
      const res = await coreRequest.post(accessesPath()).set('Authorization', token)
        .send({ type: 'app', name: 'asa-m-' + cuid().slice(-6), token: cuid(), permissions: [{ streamId, level: 'manage' }] });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
    }
    // A hidden field: refused through every spelling.
    for (const streamId of [':_system:appId', ':account::_system:appId', ':local::_system:appId']) {
      const res = await coreRequest.post(accessesPath()).set('Authorization', token)
        .send({ type: 'app', name: 'asa-h-' + cuid().slice(-6), token: cuid(), permissions: [{ streamId, level: 'read' }] });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
    }
    // A system-looking id that is no account field: unknown, through every spelling.
    for (const streamId of [':_system:email', ':local::_system:email', ':account::_system:email', ':account:email']) {
      const res = await coreRequest.post(accessesPath()).set('Authorization', token)
        .send({ type: 'app', name: 'asa-u-' + cuid().slice(-6), token: cuid(), permissions: [{ streamId, level: 'read' }] });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
    }
    // An allowed level through an alias: created, and stored under the canonical id.
    const ok = await coreRequest.post(accessesPath()).set('Authorization', token)
      .send({ type: 'app', name: 'asa-ok-' + cuid().slice(-6), token: cuid(), permissions: [{ streamId: ':account::system:email', level: 'read' }] });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.access.permissions.filter((p) => p.streamId != null).map((p) => p.streamId), [':system:email']);
    // accesses.update with an alias at too high a level: refused.
    const upd = await coreRequest.put(accessesPath() + '/' + ok.body.access.id).set('Authorization', token)
      .send({ permissions: [{ streamId: ':account::system:email', level: 'manage' }] });
    assert.strictEqual(upd.status, 400, JSON.stringify(upd.body));
  });

  it('[ASA4] events.update cannot move an event onto an account stream through a store-prefixed id', async function () {
    const stream = await coreRequest.post('/' + username + '/streams').set('Authorization', token)
      .send({ id: 'asa-plain-' + cuid().slice(-6), name: 'ASA plain' });
    assert.strictEqual(stream.status, 201, JSON.stringify(stream.body));
    const created = await coreRequest.post(eventsPath()).set('Authorization', token)
      .send({ streamIds: [stream.body.stream.id], type: 'email/string', content: 'moved@asa.example.com' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    for (const streamId of [':system:email', ':account::system:email', ':local::system:email']) {
      const res = await coreRequest.put(eventsPath() + '/' + created.body.event.id).set('Authorization', token)
        .send({ streamIds: [streamId] });
      assert.strictEqual(res.status, 400, streamId + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body?.error?.id, 'invalid-operation', streamId);
    }
    assert.strictEqual(await currentEmail(), email);
  });

  it('[ASA5] an account event cannot be deleted, whatever spelling of its id is used', async function () {
    const list = await coreRequest.get(eventsPath()).set('Authorization', token).query({ streams: [':system:email'] });
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const emailEvent = (list.body.events || []).find((e) => e.type === 'email/string');
    assert.ok(emailEvent != null, 'the email event is readable: ' + JSON.stringify(list.body.events));
    const canonical = await coreRequest.delete(eventsPath() + '/' + encodeURIComponent(emailEvent.id)).set('Authorization', token);
    assert.strictEqual(canonical.status, 400, JSON.stringify(canonical.body));
    const alias = await coreRequest.delete(eventsPath() + '/' + encodeURIComponent(':account:' + emailEvent.id)).set('Authorization', token);
    assert.notStrictEqual(alias.status, 200, JSON.stringify(alias.body));
    assert.strictEqual(await currentEmail(), email);
  });
});
