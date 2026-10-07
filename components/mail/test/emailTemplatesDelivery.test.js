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
const os = require('node:os');

require('test-helpers/src/api-server-tests-config.ts');

const { createEmailTemplatesDelivery } = require('../src/emailTemplatesDelivery.ts');

const STUB_TEMPLATES = [
  { type: 'welcome-email', lang: 'en', part: 'subject', pug: '| Welcome' },
  { type: 'welcome-email', lang: 'en', part: 'html', pug: 'p Welcome, #{username}.' },
  { type: 'welcome-email', lang: 'fr', part: 'subject', pug: '| Bienvenue' },
  { type: 'welcome-email', lang: 'fr', part: 'html', pug: 'p Bienvenue, #{username}.' },
  { type: 'reset-password', lang: 'en', part: 'subject', pug: '| Reset password' },
  { type: 'reset-password', lang: 'en', part: 'html', pug: 'p Token: #{token}' }
];

const SMTP = { jsonTransport: true }; // nodemailer JSON transport — no network
const FROM = { name: 'Pryv Test', address: 'test@example.com' };

describe('[MAILADAPT] emailTemplatesDelivery', () => {
  let delivery;

  afterEach(async () => {
    if (delivery) {
      await delivery.close();
      delivery = null;
    }
  });

  it('[MADP1] materialises PlatformDB rows to the expected tmp-dir layout', async () => {
    delivery = await createEmailTemplatesDelivery({
      getAllMailTemplates: async () => STUB_TEMPLATES,
      smtp: SMTP,
      from: FROM,
      tmpDirRoot: os.tmpdir()
    });
    const subjectPath = path.join(delivery.tmpDir, 'welcome-email', 'en', 'subject.pug');
    const htmlPath = path.join(delivery.tmpDir, 'reset-password', 'en', 'html.pug');
    await assert.doesNotReject(() => fs.access(subjectPath));
    await assert.doesNotReject(() => fs.access(htmlPath));
    assert.strictEqual((await fs.readFile(subjectPath, 'utf8')).trim(), '| Welcome');
  });

  it('[MADP2] exposes templateExists against the materialised dir', async () => {
    delivery = await createEmailTemplatesDelivery({
      getAllMailTemplates: async () => STUB_TEMPLATES,
      smtp: SMTP,
      from: FROM
    });
    assert.strictEqual(await delivery.templateExists('welcome-email/en/subject.pug'), true);
    assert.strictEqual(await delivery.templateExists('welcome-email/en/html.pug'), true);
    assert.strictEqual(await delivery.templateExists('welcome-email/zh/html.pug'), false);
    assert.strictEqual(await delivery.templateExists('does-not-exist/en/html.pug'), false);
  });

  it('[MADP3] refresh() re-materialises when PlatformDB rows change', async () => {
    let rows = STUB_TEMPLATES;
    delivery = await createEmailTemplatesDelivery({
      getAllMailTemplates: async () => rows,
      smtp: SMTP,
      from: FROM
    });
    assert.strictEqual(await delivery.templateExists('welcome-email/fr/html.pug'), true);

    rows = STUB_TEMPLATES.filter(r => r.lang !== 'fr');
    await delivery.refresh();
    assert.strictEqual(await delivery.templateExists('welcome-email/fr/html.pug'), false, 'fr row should be gone after refresh');
    assert.strictEqual(await delivery.templateExists('welcome-email/en/html.pug'), true, 'en row should still be present');
  });

  it('[MADP4] send() renders Pug + dispatches via the configured nodemailer transport', async () => {
    delivery = await createEmailTemplatesDelivery({
      getAllMailTemplates: async () => STUB_TEMPLATES,
      smtp: SMTP, // nodemailer jsonTransport returns { message: JSON } instead of sending
      from: FROM
    });
    const info = await delivery.send({
      message: { to: { name: 'Alice', address: 'alice@example.com' } },
      template: 'welcome-email/en',
      locals: { username: 'alice' }
    });
    assert.ok(info.originalMessage || info.message, 'should return a delivery envelope');
    const payload = JSON.parse(info.message);
    // nodemailer's jsonTransport preserves the object form of `from`; if
    // callers pass a string like '"Name" <addr>' it stays a string. Accept both.
    const fromRendered = typeof payload.from === 'string'
      ? payload.from
      : `"${payload.from.name}" <${payload.from.address}>`;
    assert.strictEqual(fromRendered, '"Pryv Test" <test@example.com>');
    assert.deepStrictEqual(payload.to, [{ name: 'Alice', address: 'alice@example.com' }]);
    assert.strictEqual(payload.subject, 'Welcome');
    assert.ok(payload.html.includes('Welcome, alice'), 'Pug html body should interpolate the locals');
  });

  it('[MADP6] skips rows outside the allowed Pug subset or with path segments, and writes nothing outside its dir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'madp6-'));
    try {
      delivery = await createEmailTemplatesDelivery({
        getAllMailTemplates: async () => [
          ...STUB_TEMPLATES,
          { type: 'evil', lang: 'en', part: 'subject', pug: '| x' },
          { type: 'evil', lang: 'en', part: 'html', pug: '- process.exit(1)\np x' },
          { type: '..', lang: '..', part: 'escaped', pug: 'p x' },
          { type: 'welcome-email', lang: 'de', part: '../../../escaped', pug: 'p x' }
        ],
        smtp: SMTP,
        from: FROM,
        tmpDirRoot: root
      });
      assert.strictEqual(await delivery.templateExists('welcome-email/en/html.pug'), true, 'valid rows still materialised');
      assert.strictEqual(await delivery.templateExists('evil/en/html.pug'), false, 'a template carrying code is not materialised');
      const entries = await fs.readdir(root);
      assert.deepStrictEqual(entries.filter((e) => !e.startsWith('pryv-mail-')), [], 'nothing written next to the tmp dir');
      await assert.rejects(() => fs.access(path.join(root, 'escaped.pug')));
    } finally {
      if (delivery) { await delivery.close(); delivery = null; }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('[MADP7] never reads a file a rendered template points at (CSS inlining only)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'madp7-'));
    const secretFile = path.join(root, 'secret.css');
    await fs.writeFile(secretFile, 'p { color: red } /* SECRET-MADP7 */', 'utf8');
    try {
      delivery = await createEmailTemplatesDelivery({
        getAllMailTemplates: async () => [
          { type: 'probe', lang: 'en', part: 'subject', pug: '| Probe' },
          // relative to the materialised dir, which sits next to the file
          { type: 'probe', lang: 'en', part: 'html', pug: '| <link data-inline rel="stylesheet" href="../secret.css">\np body' }
        ],
        smtp: SMTP,
        from: FROM,
        tmpDirRoot: root
      });
      const info = await delivery.send({
        message: { to: { name: 'Alice', address: 'alice@example.com' } },
        template: 'probe/en',
        locals: {}
      });
      const payload = JSON.parse(info.message);
      assert.ok(payload.html.includes('body'), 'the template rendered');
      assert.ok(!payload.html.includes('SECRET-MADP7'), 'the linked file was not inlined: ' + payload.html);
    } finally {
      if (delivery) { await delivery.close(); delivery = null; }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('[MADP5] rejects missing getAllMailTemplates / smtp arguments', async () => {
    await assert.rejects(
      () => createEmailTemplatesDelivery({ smtp: SMTP }),
      /getAllMailTemplates function is required/
    );
    await assert.rejects(
      () => createEmailTemplatesDelivery({ getAllMailTemplates: async () => [] }),
      /smtp transport config is required/
    );
  });
});
