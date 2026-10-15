/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, assert */

const cuid = require('cuid');

describe('[MAILADM] /system/admin/mail/* admin-key-gated routes', () => {
  let adminKey;
  let platformDB;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    adminKey = config.get('auth:adminAccessKey');
    platformDB = require('storages').platformDB;
  });

  async function cleanup () {
    const rows = await platformDB.getAllMailTemplates();
    for (const r of rows) await platformDB.deleteMailTemplate(r.type, r.lang, r.part);
  }

  afterEach(async () => { await cleanup(); });

  function authHeaders () { return { authorization: adminKey }; }

  it('[MA01] GET /system/admin/mail/templates without admin key is rejected', async () => {
    // checkAuth in routes/system.js returns 404 (unknownResource) for
    // unauthorized requests — by design, to avoid encouraging retries.
    const res = await coreRequest.get('/system/admin/mail/templates');
    assert.strictEqual(res.status, 404, 'expected 404 unknown-resource, got ' + res.status);
  });

  it('[MA02] GET /system/admin/mail/templates with admin key returns an empty list when PlatformDB is empty', async () => {
    const res = await coreRequest.get('/system/admin/mail/templates').set(authHeaders());
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { templates: [] });
  });

  it('[MA03] PUT writes a template row and GET list reflects it', async () => {
    const type = 'welcome-' + cuid();
    const pug = 'p Hello, #{username}.';
    const putRes = await coreRequest
      .put('/system/admin/mail/templates/' + type + '/en/html')
      .set(authHeaders())
      .send({ pug });
    assert.strictEqual(putRes.status, 204);

    const listRes = await coreRequest.get('/system/admin/mail/templates').set(authHeaders());
    const row = listRes.body.templates.find(r => r.type === type);
    assert.ok(row, 'new row should appear in list');
    assert.strictEqual(row.lang, 'en');
    assert.strictEqual(row.part, 'html');
    assert.strictEqual(row.length, pug.length);
  });

  it('[MA04] GET single template returns raw Pug as text/plain', async () => {
    const type = 'get-' + cuid();
    const pug = '| raw-pug-' + cuid();
    await platformDB.setMailTemplate(type, 'en', 'subject', pug);
    const res = await coreRequest
      .get('/system/admin/mail/templates/' + type + '/en/subject')
      .set(authHeaders());
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.strictEqual(res.text, pug);
  });

  it('[MA05] GET missing template returns 404 unknown-resource', async () => {
    const res = await coreRequest
      .get('/system/admin/mail/templates/nope-' + cuid() + '/en/subject')
      .set(authHeaders());
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  });

  it('[MA06] PUT body without pug string is rejected with 400', async () => {
    const res = await coreRequest
      .put('/system/admin/mail/templates/welcome/en/html')
      .set(authHeaders())
      .send({ notPug: 'oops' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  it('[MA07] DELETE removes the targeted template row', async () => {
    const type = 'del-' + cuid();
    await platformDB.setMailTemplate(type, 'en', 'subject', 'S');
    await platformDB.setMailTemplate(type, 'en', 'html', 'H');
    const res = await coreRequest
      .delete('/system/admin/mail/templates/' + type + '/en/subject')
      .set(authHeaders());
    assert.strictEqual(res.status, 204);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'subject'), null);
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'html'), 'H');
  });

  it('[MA08] POST send-test with missing body fields is rejected', async () => {
    const res = await coreRequest
      .post('/system/admin/mail/send-test')
      .set(authHeaders())
      .send({ type: 'welcome-email' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  it('[MA09] POST send-test on a cluster with no SMTP configured is rejected cleanly', async () => {
    const type = 'sendtest-' + cuid();
    await platformDB.setMailTemplate(type, 'en', 'subject', '| Test');
    await platformDB.setMailTemplate(type, 'en', 'html', 'p Test');
    // Ensure no stale mail state from prior runs.
    const mail = require('mail');
    await mail.close();
    const res = await coreRequest
      .post('/system/admin/mail/send-test')
      .set(authHeaders())
      .send({ type, lang: 'en', recipient: 'nobody@example.com' });
    // Without services.email.smtp.host the route must refuse fast: mail is
    // not configured (503), not an unexpected error.
    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'api-unavailable');
    assert.match(res.body.error.message, /Mail is not configured/);
  });

  it('[MA51] PUT refuses a template carrying code and stores nothing', async () => {
    const type = 'code-' + cuid();
    for (const pug of ['- global.x = 1\np x', 'p !{username}', 'p #{process.env.HOME}', 'include /etc/hosts']) {
      const res = await coreRequest
        .put('/system/admin/mail/templates/' + type + '/en/html')
        .set(authHeaders())
        .send({ pug });
      assert.strictEqual(res.status, 400, pug + ': ' + JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    }
    assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'html'), null);
  });

  it('[MA52] PUT refuses a type, lang or part outside ^[a-z0-9-]+$', async () => {
    for (const p of ['Bad_Type/en/html', 'welcome-email/EN/html', 'welcome-email/en/html.pug']) {
      const res = await coreRequest
        .put('/system/admin/mail/templates/' + p)
        .set(authHeaders())
        .send({ pug: 'p ok' });
      assert.strictEqual(res.status, 400, p + ': ' + JSON.stringify(res.body));
    }
    assert.deepStrictEqual((await platformDB.getAllMailTemplates()).length, 0);
  });

  it('[MA53] the process that served a PUT or DELETE sends the new template right away', async () => {
    // The test core is the serving worker: no master relays anything here.
    const mail = require('mail');
    await mail.close();
    await mail.init({
      getAllMailTemplates: () => platformDB.getAllMailTemplates(),
      smtp: { jsonTransport: true },
      from: { name: 'Pryv Test', address: 'test@example.com' },
      defaultLang: 'en'
    });
    const type = 'reload-' + cuid();
    async function put (lang, part, pug) {
      const res = await coreRequest.put(`/system/admin/mail/templates/${type}/${lang}/${part}`).set(authHeaders()).send({ pug });
      assert.strictEqual(res.status, 204, JSON.stringify(res.body));
    }
    async function subject (lang) {
      const { sent, result } = await mail.send({ type, lang, recipient: { email: 'ma12@example.com', name: 'ma12' } });
      assert.strictEqual(sent, true);
      return JSON.parse(result.message).subject;
    }
    try {
      await put('en', 'subject', '| Version one');
      await put('en', 'html', 'p Hello');
      assert.strictEqual(await subject('en'), 'Version one');
      await put('en', 'subject', '| Version two');
      assert.strictEqual(await subject('en'), 'Version two', 'a PUT is used by the process that served it');

      await put('fr', 'subject', '| Version française');
      await put('fr', 'html', 'p Bonjour');
      assert.strictEqual(await subject('fr'), 'Version française');
      for (const part of ['subject', 'html']) {
        const res = await coreRequest.delete(`/system/admin/mail/templates/${type}/fr/${part}`).set(authHeaders());
        assert.strictEqual(res.status, 204);
      }
      assert.strictEqual(await subject('fr'), 'Version two', 'after a DELETE the default language is used');
    } finally {
      await mail.close();
    }
  });

  it('[MA54] a PUT whose reload fails answers 503, with the template stored', async () => {
    const mail = require('mail');
    await mail.close();
    let reads = 0;
    await mail.init({
      getAllMailTemplates: async () => {
        if (reads++ > 0) throw new Error('MA54 reload failure');
        return [];
      },
      smtp: { jsonTransport: true },
      from: { name: 'Pryv Test', address: 'test@example.com' }
    });
    const type = 'reloadfail-' + cuid();
    try {
      const res = await coreRequest.put(`/system/admin/mail/templates/${type}/en/subject`).set(authHeaders()).send({ pug: '| Stored' });
      assert.strictEqual(res.status, 503, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'api-unavailable');
      assert.strictEqual(await platformDB.getMailTemplate(type, 'en', 'subject'), '| Stored');
    } finally {
      await mail.close();
    }
  });
});
