/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// Attachments are served with the content type declared at upload. A type a
// browser executes or renders as a document must not run on the API origin:
// it is served as a download inside a capability-less sandbox. Other types are
// served unchanged, and no type is refused at upload.
describe('[ACTY] attachments with an active content type', function () {
  this.timeout(60_000);

  const SANDBOX_CSP = "sandbox; default-src 'none'";
  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'acty-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'acty-files', name: 'acty-files' });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function upload (fileName, contentType, content) {
    const created = await coreRequest
      .post('/' + username + '/events')
      .set('Authorization', token)
      .field('event', JSON.stringify({ streamIds: ['acty-files'], type: 'file/attached' }))
      .attach('file', Buffer.from(content), { filename: fileName, contentType });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const attachment = created.body.event.attachments[0];
    assert.strictEqual(attachment.type, contentType, 'the declared type is kept at upload');
    return { eventId: created.body.event.id, attachment };
  }

  function assertNeutralised (res, fileName) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-disposition'], "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    assert.strictEqual(res.headers['content-security-policy'], SANDBOX_CSP);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  }

  function assertUnchanged (res, fileName, contentType) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], contentType);
    assert.strictEqual(res.headers['content-disposition'], "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    assert.strictEqual(res.headers['content-security-policy'], undefined);
  }

  it('[ACH1] serves a text/html attachment as a sandboxed download', async function () {
    const { eventId, attachment } = await upload('page.html', 'text/html', '<script>alert(1)</script>');
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id)
      .set('Authorization', token);
    assertNeutralised(res, 'page.html');
    assert.match(res.headers['content-type'], /^text\/html/);
  });

  it('[ACS1] serves an image/svg+xml attachment as a sandboxed download', async function () {
    const { eventId, attachment } = await upload('pic.svg', 'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id + '/pic.svg')
      .set('Authorization', token)
      .buffer(true);
    assertNeutralised(res, 'pic.svg');
    assert.strictEqual(res.headers['content-type'], 'image/svg+xml');
  });

  it('[ACR1] neutralises an active type on the readToken path too', async function () {
    const { eventId, attachment } = await upload('page2.html', 'text/html', '<p>hi</p>');
    assert.ok(attachment.readToken, 'the created event carries a readToken');
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id)
      .query({ readToken: attachment.readToken });
    assertNeutralised(res, 'page2.html');
  });

  it('[ACP1] serves an image/png attachment unchanged', async function () {
    const { eventId, attachment } = await upload('pic.png', 'image/png', 'not really a png');
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id)
      .set('Authorization', token)
      .buffer(true);
    assertUnchanged(res, 'pic.png', 'image/png');
  });

  it('[ACD1] serves an application/pdf attachment unchanged, also with a readToken', async function () {
    const { eventId, attachment } = await upload('doc.pdf', 'application/pdf', '%PDF-1.4 not really');
    const res = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id)
      .set('Authorization', token)
      .buffer(true);
    assertUnchanged(res, 'doc.pdf', 'application/pdf');
    const viaToken = await coreRequest
      .get('/' + username + '/events/' + eventId + '/' + attachment.id)
      .query({ readToken: attachment.readToken })
      .buffer(true);
    assertUnchanged(viaToken, 'doc.pdf', 'application/pdf');
  });

  it('[ACU1] isActiveContentType() decides on the type essence', function () {
    const { isActiveContentType } = require('../src/middleware/attachment-access.ts');
    for (const t of ['text/html', 'TEXT/HTML; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml',
      'text/xml', 'application/xml', 'application/rss+xml', 'text/javascript', 'application/javascript',
      'application/ecmascript', ' text/html ', 'multipart/x-mixed-replace', 'text/x-javascript',
      'application/x-ecmascript', 'text/javascript1.5']) {
      assert.strictEqual(isActiveContentType(t), true, t);
    }
    for (const t of ['image/png', 'image/jpeg', 'application/pdf', 'application/json', 'text/plain',
      'application/octet-stream', '', null, undefined]) {
      assert.strictEqual(isActiveContentType(t), false, String(t));
    }
  });
});
