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

  it('[SRD7] events.deleteAttachment on an emails container item is refused, personal token included', async function () {
    const res = await coreRequest.delete('/' + username + '/events/' + emailFile.eventId + '/' + emailFile.fileId)
      .set('Authorization', personal);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error?.data?.id, 'emails-reserved-stream', JSON.stringify(res.body));
    const stored = await mall.events.getOne(userId, emailFile.eventId);
    assert.deepStrictEqual(stored.attachments.map((a) => a.id), [emailFile.fileId]);
  });
});

/**
 * The write methods by id (events.update, events.delete,
 * events.deleteAttachment) refuse an event the access cannot read: one with a
 * stream held at `none` or `create-only` is refused with the same error as
 * events.getOne, even when another of its streams grants `contribute`.
 * Personal tokens and readable events are unchanged.
 */
describe('[WRHD] write methods refuse an event the access cannot read', function () {
  this.timeout(60_000);

  const ErrorIds = require('errors').ErrorIds;
  let fixtures, username, personal, readBToken;
  const tokenFor = {};

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'wrhd' + cuid().toLowerCase().slice(-10);
    personal = cuid();
    readBToken = cuid();
    tokenFor.none = cuid();
    tokenFor['create-only'] = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personal, type: 'personal' });
    await user.session(personal);
    await user.stream({ id: 'wrhd-a', name: 'A' });
    await user.stream({ id: 'wrhd-b', name: 'B' });
    await user.stream({ id: 'wrhd-b-child', name: 'B child', parentId: 'wrhd-b' });
    for (const level of ['none', 'create-only']) {
      await user.access({
        token: tokenFor[level],
        type: 'app',
        permissions: [{ streamId: 'wrhd-a', level: 'contribute' }, { streamId: 'wrhd-b', level }]
      });
    }
    await user.access({
      token: readBToken,
      type: 'app',
      permissions: [{ streamId: 'wrhd-a', level: 'contribute' }, { streamId: 'wrhd-b', level: 'read' }]
    });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function eventPath (id) { return '/' + username + '/events/' + id; }
  async function createMixed (streamIds = ['wrhd-a', 'wrhd-b']) {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', personal)
      .send({ streamIds, type: 'note/txt', content: 'original' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }
  async function createMixedWithFile () {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', personal)
      .field('event', JSON.stringify({ streamIds: ['wrhd-a', 'wrhd-b'], type: 'file/attached' }))
      .attach('file', Buffer.from('mixed file'), { filename: 'mixed.txt', contentType: 'text/plain' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }
  async function storedEvent (id) {
    const res = await coreRequest.get(eventPath(id)).set('Authorization', personal);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.event;
  }
  function assertForbidden (res) {
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error?.id, ErrorIds.Forbidden, JSON.stringify(res.body));
    assert.strictEqual(res.body.event, undefined, 'no event in the refusal');
  }

  const codes = {
    none: ['WRN1', 'WRN2', 'WRN3', 'WRN4', 'WRN5', 'WRN6', 'WRN7', 'WRN8', 'WRN9'],
    'create-only': ['WRC1', 'WRC2', 'WRC3', 'WRC4', 'WRC5', 'WRC6', 'WRC7', 'WRC8', 'WRC9']
  };
  for (const level of ['none', 'create-only']) {
    const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = codes[level];

    it(`[${c1}] baseline: events.getOne refuses the event to a token holding the second stream at "${level}"`, async function () {
      const ev = await createMixed();
      assertForbidden(await coreRequest.get(eventPath(ev.id)).set('Authorization', tokenFor[level]));
    });

    it(`[${c2}] "${level}": an empty update is refused and returns no event`, async function () {
      const ev = await createMixed();
      assertForbidden(await coreRequest.put(eventPath(ev.id)).set('Authorization', tokenFor[level]).send({}));
    });

    it(`[${c3}] "${level}": an update with content is refused and the event is unchanged`, async function () {
      const ev = await createMixed();
      const res = await coreRequest.put(eventPath(ev.id)).set('Authorization', tokenFor[level])
        .send({ content: 'changed', description: 'changed' });
      assertForbidden(res);
      const stored = await storedEvent(ev.id);
      assert.strictEqual(stored.content, 'original');
      assert.strictEqual(stored.description, undefined);
      assert.strictEqual(stored.modified, ev.modified);
    });

    it(`[${c4}] "${level}": delete is refused; the event is neither trashed nor, once trashed, deleted`, async function () {
      const ev = await createMixed();
      assertForbidden(await coreRequest.delete(eventPath(ev.id)).set('Authorization', tokenFor[level]));
      assert.ok(!(await storedEvent(ev.id)).trashed, 'not trashed');
      const trash = await coreRequest.delete(eventPath(ev.id)).set('Authorization', personal);
      assert.strictEqual(trash.status, 200, JSON.stringify(trash.body));
      assertForbidden(await coreRequest.delete(eventPath(ev.id)).set('Authorization', tokenFor[level]));
      assert.strictEqual((await storedEvent(ev.id)).trashed, true, 'still there, trashed');
    });

    it(`[${c5}] "${level}": deleteAttachment is refused and the attachment stays`, async function () {
      const ev = await createMixedWithFile();
      const fileId = ev.attachments[0].id;
      assertForbidden(await coreRequest.delete(eventPath(ev.id) + '/' + fileId).set('Authorization', tokenFor[level]));
      const stored = await storedEvent(ev.id);
      assert.deepStrictEqual(stored.attachments.map((a) => a.id), [fileId]);
    });

    it(`[${c6}] "${level}": adding a file (multipart POST /events/:id) is refused and no attachment is stored`, async function () {
      const ev = await createMixedWithFile();
      const res = await coreRequest.post(eventPath(ev.id)).set('Authorization', tokenFor[level])
        .attach('file', Buffer.from('added file'), { filename: 'added.txt', contentType: 'text/plain' });
      assertForbidden(res);
      const stored = await storedEvent(ev.id);
      assert.deepStrictEqual(stored.attachments.map((a) => a.id), [ev.attachments[0].id]);
      assert.strictEqual(stored.modified, ev.modified);
    });

    it(`[${c7}] "${level}" inherited: an event on a child of the withheld stream is refused for update and delete`, async function () {
      const ev = await createMixed(['wrhd-a', 'wrhd-b-child']);
      assertForbidden(await coreRequest.get(eventPath(ev.id)).set('Authorization', tokenFor[level]));
      assertForbidden(await coreRequest.put(eventPath(ev.id)).set('Authorization', tokenFor[level]).send({ content: 'changed' }));
      assertForbidden(await coreRequest.delete(eventPath(ev.id)).set('Authorization', tokenFor[level]));
      const stored = await storedEvent(ev.id);
      assert.strictEqual(stored.content, 'original');
      assert.ok(!stored.trashed, 'not trashed');
    });

    it(`[${c8}] "${level}": dropping the withheld stream through streamIds is refused, streamIds unchanged`, async function () {
      const ev = await createMixed();
      assertForbidden(await coreRequest.put(eventPath(ev.id)).set('Authorization', tokenFor[level]).send({ streamIds: ['wrhd-a'] }));
      assert.deepStrictEqual((await storedEvent(ev.id)).streamIds, ['wrhd-a', 'wrhd-b']);
    });

    it(`[${c9}] "${level}": a batch call refuses events.update and events.delete`, async function () {
      const ev = await createMixed();
      const res = await coreRequest.post('/' + username).set('Authorization', tokenFor[level]).send([
        { method: 'events.update', params: { id: ev.id, update: { content: 'changed' } } },
        { method: 'events.delete', params: { id: ev.id } }
      ]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.results.length, 2, JSON.stringify(res.body));
      for (const r of res.body.results) {
        assert.strictEqual(r.error?.id, ErrorIds.Forbidden, JSON.stringify(r));
        assert.strictEqual(r.event, undefined, 'no event in the refusal');
      }
      const stored = await storedEvent(ev.id);
      assert.strictEqual(stored.content, 'original');
      assert.ok(!stored.trashed, 'not trashed');
    });
  }

  it('[WRD1] update, delete and deleteAttachment of a deleted event answer unknown-resource', async function () {
    const ev = await createMixedWithFile();
    for (let i = 0; i < 2; i++) {
      const del = await coreRequest.delete(eventPath(ev.id)).set('Authorization', personal);
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    }
    for (const token of [personal, readBToken]) {
      const calls = [
        coreRequest.put(eventPath(ev.id)).set('Authorization', token).send({ content: 'changed' }),
        coreRequest.delete(eventPath(ev.id)).set('Authorization', token),
        coreRequest.delete(eventPath(ev.id) + '/' + ev.attachments[0].id).set('Authorization', token)
      ];
      for (const res of await Promise.all(calls)) {
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
        assert.strictEqual(res.body.error?.id, ErrorIds.UnknownResource, JSON.stringify(res.body));
      }
    }
  });

  it('[WRR1] control: with the second stream at "read", update and delete are accepted', async function () {
    const ev = await createMixed();
    const read = await coreRequest.get(eventPath(ev.id)).set('Authorization', readBToken);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const upd = await coreRequest.put(eventPath(ev.id)).set('Authorization', readBToken).send({ content: 'changed' });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assert.strictEqual(upd.body.event.content, 'changed');
    const del = await coreRequest.delete(eventPath(ev.id)).set('Authorization', readBToken);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.event.trashed, true);
  });

  it('[WRP1] control: a personal token updates, trashes and deletes the same event', async function () {
    const ev = await createMixedWithFile();
    const upd = await coreRequest.put(eventPath(ev.id)).set('Authorization', personal).send({ description: 'mine' });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    const att = await coreRequest.delete(eventPath(ev.id) + '/' + ev.attachments[0].id).set('Authorization', personal);
    assert.strictEqual(att.status, 200, JSON.stringify(att.body));
    const trash = await coreRequest.delete(eventPath(ev.id)).set('Authorization', personal);
    assert.strictEqual(trash.status, 200, JSON.stringify(trash.body));
    assert.strictEqual(trash.body.event.trashed, true);
    const del = await coreRequest.delete(eventPath(ev.id)).set('Authorization', personal);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.eventDeletion.id, ev.id);
  });
});

/**
 * Accesses migrated from v1 tag permissions carry forced streams: events.get
 * and events.getOne hide an event outside them, and the write methods by id
 * refuse it the same way. (Such a permission cannot be written through the
 * API: the fixture stores it directly, as the migration did.)
 */
describe('[WRFD] write methods refuse an event outside the forced streams', function () {
  this.timeout(60_000);

  const ErrorIds = require('errors').ErrorIds;
  let fixtures, username, personal, forcedToken;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'wrfd' + cuid().toLowerCase().slice(-10);
    personal = cuid();
    forcedToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personal, type: 'personal' });
    await user.session(personal);
    await user.stream({ id: 'wrfd-a', name: 'A' });
    await user.stream({ id: 'wrfd-forced', name: 'forced' });
    await user.access({
      token: forcedToken,
      type: 'app',
      permissions: [
        { streamId: 'wrfd-a', level: 'contribute' },
        { streamId: 'wrfd-forced', level: 'contribute' },
        { feature: 'forcedStreams', streams: ['wrfd-forced'] }
      ]
    });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  function eventPath (id) { return '/' + username + '/events/' + id; }
  async function create (streamIds) {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', personal)
      .send({ streamIds, type: 'note/txt', content: 'original' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }
  async function createOutsideWithFile () {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', personal)
      .field('event', JSON.stringify({ streamIds: ['wrfd-a'], type: 'file/attached' }))
      .attach('file', Buffer.from('outside file'), { filename: 'outside.txt', contentType: 'text/plain' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }
  async function storedEvent (id) {
    const res = await coreRequest.get(eventPath(id)).set('Authorization', personal);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body.event;
  }
  function assertForbidden (res) {
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error?.id, ErrorIds.Forbidden, JSON.stringify(res.body));
    assert.strictEqual(res.body.event, undefined, 'no event in the refusal');
  }

  it('[WRF1] premise: events.getOne refuses an event outside the forced stream and returns one inside it', async function () {
    const outside = await create(['wrfd-a']);
    assertForbidden(await coreRequest.get(eventPath(outside.id)).set('Authorization', forcedToken));
    const inside = await create(['wrfd-a', 'wrfd-forced']);
    const res = await coreRequest.get(eventPath(inside.id)).set('Authorization', forcedToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  it('[WRF2] an update (empty or with content) of an event outside the forced stream is refused, the event unchanged', async function () {
    const ev = await create(['wrfd-a']);
    assertForbidden(await coreRequest.put(eventPath(ev.id)).set('Authorization', forcedToken).send({}));
    assertForbidden(await coreRequest.put(eventPath(ev.id)).set('Authorization', forcedToken).send({ content: 'changed' }));
    const stored = await storedEvent(ev.id);
    assert.strictEqual(stored.content, 'original');
    assert.strictEqual(stored.modified, ev.modified);
  });

  it('[WRF3] delete of an event outside the forced stream is refused; neither trashed nor, once trashed, deleted', async function () {
    const ev = await create(['wrfd-a']);
    assertForbidden(await coreRequest.delete(eventPath(ev.id)).set('Authorization', forcedToken));
    assert.ok(!(await storedEvent(ev.id)).trashed, 'not trashed');
    const trash = await coreRequest.delete(eventPath(ev.id)).set('Authorization', personal);
    assert.strictEqual(trash.status, 200, JSON.stringify(trash.body));
    assertForbidden(await coreRequest.delete(eventPath(ev.id)).set('Authorization', forcedToken));
    assert.strictEqual((await storedEvent(ev.id)).trashed, true, 'still there, trashed');
  });

  it('[WRF4] deleteAttachment on an event outside the forced stream is refused and the attachment stays', async function () {
    const ev = await createOutsideWithFile();
    const fileId = ev.attachments[0].id;
    assertForbidden(await coreRequest.delete(eventPath(ev.id) + '/' + fileId).set('Authorization', forcedToken));
    assert.deepStrictEqual((await storedEvent(ev.id)).attachments.map((a) => a.id), [fileId]);
  });

  it('[WRF5] control: an event inside the forced stream is updated and trashed', async function () {
    const ev = await create(['wrfd-a', 'wrfd-forced']);
    const upd = await coreRequest.put(eventPath(ev.id)).set('Authorization', forcedToken).send({ content: 'changed' });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    assert.strictEqual(upd.body.event.content, 'changed');
    const del = await coreRequest.delete(eventPath(ev.id)).set('Authorization', forcedToken);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.event.trashed, true);
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

  it('[SRC7] an inbox event carries an attachment (personal update); an app token cannot remove it, the personal token can', async function () {
    const genuine = await mall.events.create(userId, {
      streamIds: [INBOX], type: 'consent/request-cmc', content: requestContent('https://requester.example.com/cap')
    });
    const added = await coreRequest.post(eventsPath() + '/' + genuine.id).set('Authorization', personal)
      .attach('file', Buffer.from('inbox file'), { filename: 'inbox.txt', contentType: 'text/plain' });
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const fileId = added.body.event.attachments[0].id;
    const path = eventsPath() + '/' + genuine.id + '/' + fileId;
    const refused = await coreRequest.delete(path).set('Authorization', appToken);
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.error?.data?.id, PROTECTED);
    assert.deepStrictEqual((await mall.events.getOne(userId, genuine.id)).attachments.map((a) => a.id), [fileId]);
    const own = await coreRequest.delete(path).set('Authorization', personal);
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  });

  it('[SRC8] update and delete answer unknown-resource for a plugin-internal event, as getOne does; the inbox keeps its refusal', async function () {
    const internal = await mall.events.create(userId, { streamIds: [responsesStreamId], type: 'note/txt', content: 'internal' });
    for (const token of [appToken, capabilityToken]) {
      const calls = [
        coreRequest.get(eventsPath() + '/' + internal.id).set('Authorization', token),
        coreRequest.put(eventsPath() + '/' + internal.id).set('Authorization', token).send({ content: 'changed' }),
        coreRequest.delete(eventsPath() + '/' + internal.id).set('Authorization', token)
      ];
      for (const res of await Promise.all(calls)) {
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
        assert.strictEqual(res.body.error?.id, 'unknown-resource', JSON.stringify(res.body));
      }
    }
    const stored = await mall.events.getOne(userId, internal.id);
    assert.strictEqual(stored.content, 'internal');
    assert.ok(!stored.trashed, 'not trashed');
    // the inbox is visible to the app token: its refusal keeps the CMC id
    const inbox = await mall.events.create(userId, {
      streamIds: [INBOX], type: 'consent/request-cmc', content: requestContent('https://requester.example.com/cap')
    });
    const read = await coreRequest.get(eventsPath() + '/' + inbox.id).set('Authorization', appToken);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const del = await coreRequest.delete(eventsPath() + '/' + inbox.id).set('Authorization', appToken);
    assert.strictEqual(del.status, 403, JSON.stringify(del.body));
    assert.strictEqual(del.body.error?.data?.id, PROTECTED);
  });

  it('[SRC6] a capability access writes only into its own responses stream', async function () {
    const ownStream = await create(capabilityToken, { streamIds: [responsesStreamId], type: 'note/txt', content: 'answer' });
    assert.strictEqual(ownStream.status, 201, JSON.stringify(ownStream.body));
    const other = await create(capabilityToken, { streamIds: [otherResponsesStreamId], type: 'note/txt', content: 'answer' });
    assert.strictEqual(other.status, 403, JSON.stringify(other.body));
  });
});
