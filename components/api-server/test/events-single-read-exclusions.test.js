/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Reading one event by id (events.getOne, attachments) applies the same
 * exclusions as events.get: an app token does not reach an event that has a
 * stream it is denied (`none`), nor an item of the emails container, even
 * with a `*` read grant. Personal tokens are unchanged.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const { getMall } = require('mall');
const { getUsersRepository } = require('business/src/users/index.ts');
const container = require('business/src/emails/container.ts');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');

const EMAILS = ':_emails:';

describe('[SRDX] single-event reads apply the events.get exclusions', function () {
  this.timeout(60_000);

  let fixtures, mall, username, userId, personal, starNoneToken, starToken, readAToken;
  let mixedId, onlyAId, emailEventId, mixedFile, emailFile;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    mall = await getMall();
    username = 'srdx' + cuid().toLowerCase().slice(-10);
    personal = cuid();
    starNoneToken = cuid();
    starToken = cuid();
    readAToken = cuid();
    const user = await fixtures.user(username, { email: cuid() + '@srdx.example.com' });
    await user.access({ token: personal, type: 'personal' });
    await user.session(personal);
    await user.stream({ id: 'srdx-a', name: 'A' });
    await user.stream({ id: 'srdx-b', name: 'B', parentId: 'srdx-a' });
    await user.stream({ id: 'srdx-loose', name: 'loose' });
    await user.access({
      token: starNoneToken,
      type: 'app',
      permissions: [{ streamId: '*', level: 'read' }, { streamId: 'srdx-b', level: 'none' }]
    });
    await user.access({ token: starToken, type: 'app', permissions: [{ streamId: '*', level: 'read' }] });
    await user.access({ token: readAToken, type: 'app', permissions: [{ streamId: 'srdx-a', level: 'read' }] });
    userId = await (await getUsersRepository()).getUserIdForUsername(username);

    mixedId = (await createEvent({ streamIds: ['srdx-a', 'srdx-b'], type: 'note/txt', content: 'mixed' })).id;
    onlyAId = (await createEvent({ streamIds: ['srdx-a'], type: 'note/txt', content: 'only a' })).id;

    // seed the emails container through the account method
    const add = await coreRequest.put('/' + username + '/account').set('Authorization', personal)
      .send({ emails: { add: [cuid() + '@srdx-extra.example.com'] } });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const raw = await container.getRawEvents(userId);
    assert.ok(raw.length > 0, 'premise: the container holds an item');
    emailEventId = raw[0].id;

    const upload = await coreRequest.post('/' + username + '/events').set('Authorization', personal)
      .field('event', JSON.stringify({ streamIds: ['srdx-a', 'srdx-b'], type: 'file/attached' }))
      .attach('file', Buffer.from('mixed file'), { filename: 'mixed.txt', contentType: 'text/plain' });
    assert.strictEqual(upload.status, 201, JSON.stringify(upload.body));
    mixedFile = { eventId: upload.body.event.id, fileId: upload.body.event.attachments[0].id };

    // the events API refuses writes into the container: seed one with a file directly
    const tmp = nodePath.join(os.tmpdir(), 'srdx-' + process.pid + '.txt');
    fs.writeFileSync(tmp, 'email file');
    try {
      const ev = await mall.events.createWithAttachments(userId,
        // carries an address the account owns, so the platform cross-check stays consistent
        { streamIds: [EMAILS], type: 'file/attached', content: { value: raw[0].content.value } },
        [{ fileName: 'email.txt', type: 'text/plain', size: 10, attachmentData: fs.createReadStream(tmp) }]);
      emailFile = { eventId: ev.id, fileId: ev.attachments[0].id };
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function createEvent (event) {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', personal).send(event);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }
  function getOne (id, token) {
    return coreRequest.get('/' + username + '/events/' + id).set('Authorization', token);
  }
  function getFile (file, token) {
    return coreRequest.get('/' + username + '/events/' + file.eventId + '/' + file.fileId).set('Authorization', token);
  }

  it('[SRD1] events.getOne refuses an event that has a stream the app token is denied', async function () {
    const denied = await getOne(mixedId, starNoneToken);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    const allowed = await getOne(onlyAId, starNoneToken);
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    const own = await getOne(mixedId, personal);
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  });

  it('[SRD2] events.getOne refuses an emails container item to a star read app token', async function () {
    const denied = await getOne(emailEventId, starToken);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    const own = await getOne(emailEventId, personal);
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  });

  it('[SRD3] attachments are refused for an event that has a denied stream', async function () {
    const denied = await getFile(mixedFile, starNoneToken);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    const own = await getFile(mixedFile, personal);
    assert.strictEqual(own.status, 200);
  });

  it('[SRD4] attachments of an emails container item are refused to a star read app token', async function () {
    const denied = await getFile(emailFile, starToken);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    const own = await getFile(emailFile, personal);
    assert.strictEqual(own.status, 200);
  });

  it('[SRD5] events.get keeps the same exclusions (unchanged)', async function () {
    const res = await coreRequest.get('/' + username + '/events').set('Authorization', starNoneToken)
      .query({ limit: 100 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.events.map((e) => e.id);
    assert.ok(!ids.includes(mixedId), 'the mixed event is excluded');
    assert.ok(ids.includes(onlyAId), 'the plain event is listed');
  });

  it('[SRD6] an event with a stream that has no grant stays readable through its granted stream', async function () {
    const ev = await createEvent({ streamIds: ['srdx-a', 'srdx-loose'], type: 'note/txt', content: 'loose' });
    const res = await getOne(ev.id, readAToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });
});

describe('[SRCU] CMC protections on events.update and internal writes', function () {
  this.timeout(60_000);

  const cmc = require('cmc');
  const INBOX = ':_cmc:inbox';
  const CHAT = ':_cmc:apps:srcuapp:chats:peer-one';
  const PROTECTED = 'cmc-protected-event-write';
  let fixtures, mall, username, userId, personal, appToken, counterpartyToken, capabilityToken;
  let responsesStreamId, otherResponsesStreamId;

  const requestContent = (url) => ({
    to: null,
    request: {
      title: { en: 'Study' },
      description: { en: 'A study' },
      consent: { en: 'I agree' },
      permissions: [{ streamId: 'srcu-data', level: 'read' }]
    },
    from: { username: 'requester', host: 'requester.example.com' },
    capabilityUrl: url
  });

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    mall = await getMall();
    username = 'srcu' + cuid().toLowerCase().slice(-10);
    personal = cuid();
    appToken = cuid();
    counterpartyToken = cuid();
    capabilityToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personal, type: 'personal' });
    await user.session(personal);
    await user.stream({ id: 'srcu-data', name: 'data' });
    userId = await (await getUsersRepository()).getUserIdForUsername(username);
    await cmc.provisionUserStreams({ mall, userId, logger: { info () {}, warn () {}, debug () {}, error () {} } });
    for (const [id, parentId] of [
      [':_cmc:apps:srcuapp', ':_cmc:apps'],
      [':_cmc:apps:srcuapp:chats', ':_cmc:apps:srcuapp'],
      [CHAT, ':_cmc:apps:srcuapp:chats']
    ]) {
      await mall.streams.create(userId, { id, parentId, name: id });
    }
    responsesStreamId = cmc.constants.responsesStreamIdFor('srcucap1');
    otherResponsesStreamId = cmc.constants.responsesStreamIdFor('srcucap2');
    for (const id of [responsesStreamId, otherResponsesStreamId]) {
      await mall.streams.create(userId, { id, parentId: cmc.constants.NS_INTERNAL, name: id });
    }
    await user.access({ token: appToken, type: 'app', permissions: [{ streamId: '*', level: 'contribute' }] });
    await user.access({
      token: counterpartyToken,
      type: 'shared',
      permissions: [{ streamId: CHAT, level: 'contribute' }],
      clientData: { cmc: { role: 'counterparty', counterparty: { username: 'peer-one', host: 'peer.example.com' } } }
    });
    await user.access({
      token: capabilityToken,
      type: 'shared',
      permissions: [{ streamId: responsesStreamId, level: 'create-only' }],
      clientData: { cmc: { kind: 'capability', capabilityId: 'srcucap1' } }
    });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function eventsPath () { return '/' + username + '/events'; }
  async function create (token, event) {
    return await coreRequest.post(eventsPath()).set('Authorization', token).send(event);
  }
  async function update (token, id, changes) {
    return await coreRequest.put(eventsPath() + '/' + id).set('Authorization', token).send(changes);
  }

  it('[SRC1] an app token cannot move its own event into the inbox', async function () {
    const own = await create(appToken, { streamIds: ['srcu-data'], type: 'note/txt', content: 'mine' });
    assert.strictEqual(own.status, 201, JSON.stringify(own.body));
    const moved = await update(appToken, own.body.event.id, {
      streamIds: [INBOX],
      type: 'consent/request-cmc',
      content: requestContent('https://attacker.example.com/cap')
    });
    assert.strictEqual(moved.status, 403, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.error.data?.id, PROTECTED);
  });

  it('[SRC2] an app token cannot rewrite a request delivered on the inbox; a personal token still can', async function () {
    const genuine = await mall.events.create(userId, {
      streamIds: [INBOX], type: 'consent/request-cmc', content: requestContent('https://requester.example.com/cap')
    });
    const forged = await update(appToken, genuine.id, { content: requestContent('https://attacker.example.com/cap') });
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body.error.data?.id, PROTECTED);
    const stored = await mall.events.getOne(userId, genuine.id);
    assert.strictEqual(stored.content.capabilityUrl, 'https://requester.example.com/cap');
    const own = await update(personal, genuine.id, { description: 'seen' });
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  });

  it('[SRC3] an app token cannot retype an event to or from a CMC type', async function () {
    const own = await create(appToken, { streamIds: ['srcu-data'], type: 'note/txt', content: 'mine' });
    assert.strictEqual(own.status, 201, JSON.stringify(own.body));
    const retyped = await update(appToken, own.body.event.id, {
      type: 'consent/request-cmc', content: requestContent('https://attacker.example.com/cap')
    });
    assert.strictEqual(retyped.status, 403, JSON.stringify(retyped.body));
    assert.strictEqual(retyped.body.error.data?.id, PROTECTED);
  });

  it('[SRC4] a counterparty cannot rewrite content.from on its chat messages', async function () {
    const chat = await create(counterpartyToken, { streamIds: [CHAT], type: 'message/chat-cmc', content: { content: 'hello' } });
    assert.strictEqual(chat.status, 201, JSON.stringify(chat.body));
    assert.deepStrictEqual(chat.body.event.content.from, { username: 'peer-one', host: 'peer.example.com' });
    const edited = await update(counterpartyToken, chat.body.event.id, {
      content: { content: 'edited', from: { username: 'someone-else', host: 'elsewhere.example.com' } }
    });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.deepStrictEqual(edited.body.event.content.from, { username: 'peer-one', host: 'peer.example.com' });
    assert.strictEqual(edited.body.event.content.content, 'edited');
    const stored = await mall.events.getOne(userId, chat.body.event.id);
    assert.deepStrictEqual(stored.content.from, { username: 'peer-one', host: 'peer.example.com' });
  });

  it('[SRC5] an app token cannot create events in the plugin-internal subtree', async function () {
    const res = await create(appToken, { streamIds: [responsesStreamId], type: 'note/txt', content: 'forged' });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.data?.id, PROTECTED);
  });

  it('[SRC6] a capability access writes only into its own responses stream', async function () {
    const ownStream = await create(capabilityToken, { streamIds: [responsesStreamId], type: 'note/txt', content: 'answer' });
    assert.strictEqual(ownStream.status, 201, JSON.stringify(ownStream.body));
    const other = await create(capabilityToken, { streamIds: [otherResponsesStreamId], type: 'note/txt', content: 'answer' });
    assert.strictEqual(other.status, 403, JSON.stringify(other.body));
  });
});
