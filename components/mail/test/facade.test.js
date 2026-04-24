/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');

require('test-helpers/src/api-server-tests-config');

const mail = require('../src/index');

const STUB_TEMPLATES = [
  { type: 'welcome-email', lang: 'en', part: 'subject', pug: '| Welcome' },
  { type: 'welcome-email', lang: 'en', part: 'html', pug: 'p Welcome, #{username}.' }
];

describe('[MAILFCD] mail façade', () => {
  afterEach(async () => {
    await mail.close();
  });

  it('[MFCD1] isActive() is false until init() is called', () => {
    assert.strictEqual(mail.isActive(), false);
  });

  it('[MFCD2] send() is a silent no-op when not active', async () => {
    const res = await mail.send({
      type: 'welcome-email',
      lang: 'en',
      recipient: { email: 'alice@example.com' }
    });
    assert.deepStrictEqual(res, { sent: false, skipped: 'not-active' });
  });

  it('[MFCD3] init() + send() end-to-end via nodemailer jsonTransport', async () => {
    await mail.init({
      getAllMailTemplates: async () => STUB_TEMPLATES,
      smtp: { jsonTransport: true },
      from: { name: 'Pryv Test', address: 'test@example.com' },
      defaultLang: 'en'
    });
    assert.strictEqual(mail.isActive(), true);
    const res = await mail.send({
      type: 'welcome-email',
      lang: 'en',
      recipient: { name: 'Alice', email: 'alice@example.com' },
      substitutions: { username: 'alice' }
    });
    assert.strictEqual(res.sent, true);
  });

  it('[MFCD4] send() rejects missing required fields', async () => {
    await mail.init({
      getAllMailTemplates: async () => STUB_TEMPLATES,
      smtp: { jsonTransport: true },
      from: { name: 'Pryv Test', address: 'test@example.com' }
    });
    await assert.rejects(
      () => mail.send({ type: 'welcome-email', lang: 'en', recipient: {} }),
      /recipient.email/
    );
  });
});
