/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

require('test-helpers/src/api-server-tests-config.ts');

const mail = require('../src/index.ts');

const STUB_TEMPLATES = [
  { type: 'welcome-email', lang: 'en', part: 'subject', pug: '| Welcome' },
  { type: 'welcome-email', lang: 'en', part: 'html', pug: 'p Welcome, #{username}.' }
];

const BUNDLED = path.resolve(import.meta.dirname, '../templates');

/** Walk the bundled template directory the way TemplateSeeder does, and return
 *  the rows a PlatformDB would hand back. */
async function loadBundledRows () {
  const rows = [];
  for (const type of await listDirs(BUNDLED)) {
    for (const lang of await listDirs(path.join(BUNDLED, type))) {
      const langDir = path.join(BUNDLED, type, lang);
      for (const file of await fs.readdir(langDir)) {
        if (!file.endsWith('.pug')) continue;
        rows.push({
          type,
          lang,
          part: file.replace(/\.pug$/, ''),
          pug: await fs.readFile(path.join(langDir, file), 'utf8')
        });
      }
    }
  }
  return rows;
}

async function listDirs (parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

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

  it('[MFCD6] the registration code never reaches the mail subject', async () => {
    // The code is the sole proof of inbox control for a flow that gates account
    // creation, so it must not be readable from a notification preview or a
    // mail-subject log. [MFCD5] asserts the code is SOMEWHERE in the message and
    // would stay green if it were put back in the subject, so pin it here.
    const rows = await loadBundledRows();
    await mail.init({
      getAllMailTemplates: async () => rows,
      smtp: { jsonTransport: true },
      from: { name: 'T', address: 't@example.com' },
      defaultLang: 'en'
    });
    for (const lang of ['en', 'fr']) {
      const res = await mail.send({
        type: 'email-challenge',
        lang,
        recipient: { name: 'x', email: 'x@example.com' },
        substitutions: { CODE: 'ABCD-EFGH', EMAIL: 'a@example.com', CODE_MAX_AGE_MINUTES: '10' }
      });
      const message = JSON.parse(res.result.message);
      assert.ok(!String(message.subject).includes('ABCD-EFGH'), `${lang} subject must not carry the code`);
      assert.ok(String(message.html).includes('ABCD-EFGH'), `${lang} body must carry the code`);
    }
  });

  it('[MFCD5] every bundled template renders with its documented substitutions', async () => {
    const rows = await loadBundledRows();
    await mail.init({
      getAllMailTemplates: async () => rows,
      smtp: { jsonTransport: true },
      from: { name: 'T', address: 't@example.com' },
      defaultLang: 'en'
    });
    // [type, substitutions the emitter provides, strings that must survive rendering]
    const cases = [
      ['welcome-email', { USERNAME: 'alice-u', EMAIL: 'alice@example.com' }, ['alice-u', 'alice@example.com']],
      ['reset-password', { RESET_TOKEN: 'tok-r', RESET_URL: 'https://app.example/reset', RESET_LINK: 'https://app.example/reset?resetToken=tok-r' }, ['https://app.example/reset?resetToken=tok-r']],
      ['verify-email', { VERIFY_TOKEN: 'tok-v', VERIFY_URL: 'https://app.example/verify-email', VERIFY_LINK: 'https://app.example/verify-email?verifyToken=tok-v', EMAIL: 'a@example.com', USERNAME: 'alice-u' }, ['tok-v', 'https://app.example/verify-email?verifyToken=tok-v']],
      ['email-challenge', { CODE: 'ABCD-EFGH', EMAIL: 'a@example.com', CODE_MAX_AGE_MINUTES: '10' }, ['ABCD-EFGH', '10 minutes']]
    ];
    for (const lang of ['en', 'fr']) {
      for (const [type, substitutions, expected] of cases) {
        const res = await mail.send({
          type,
          lang,
          recipient: { name: 'x', email: 'x@example.com' },
          substitutions
        });
        assert.strictEqual(res.sent, true, `${type}/${lang} was not sent`);
        const delivered = JSON.stringify(res.result);
        for (const s of expected) {
          assert.ok(delivered.includes(s), `${type}/${lang} should contain ${s}`);
        }
        // Belt and braces: Pug renders an unknown variable as an empty string,
        // so the assertions above are what catch a misspelt name. This only
        // guards the rarer case of "undefined" reaching the body as text.
        assert.ok(!delivered.includes('undefined'), `${type}/${lang} rendered an undefined substitution`);
      }
    }
  });
});
