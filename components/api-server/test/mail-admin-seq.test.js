/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

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
    // Without services.email.smtp.host the route must refuse fast.
    assert.ok(res.status >= 400 && res.status < 600, 'expected 4xx/5xx, got ' + res.status);
  });
});
