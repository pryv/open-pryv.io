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
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  it('[MADP8] with NODE_ENV=production, a send after refresh() renders the new template', function () {
    this.timeout(30000);
    // Compiled templates are cached by file name only outside development
    // and test, so this runs in a fresh process started in production mode
    // (importing the .ts sources relies on Node's type stripping, like the
    // rest of the suite).
    // The test config initialises the logger and sets NODE_ENV=test;
    // `email-templates` reads NODE_ENV when it loads, after that.
    const testConfig = path.resolve(__dirname, '../../test-helpers/src/api-server-tests-config.ts');
    const src = path.resolve(__dirname, '../src/emailTemplatesDelivery.ts');
    const script = [
      `await import(${JSON.stringify(testConfig)});`,
      "process.env.NODE_ENV = 'production';",
      `const { createEmailTemplatesDelivery } = await import(${JSON.stringify(src)});`,
      "let subject = 'Version one';",
      'const delivery = await createEmailTemplatesDelivery({',
      "  getAllMailTemplates: async () => [{ type: 't', lang: 'en', part: 'subject', pug: '| ' + subject }, { type: 't', lang: 'en', part: 'html', pug: 'p x' }],",
      "  smtp: { jsonTransport: true }, from: 'test@example.com'",
      '});',
      "const send = async () => JSON.parse((await delivery.send({ message: { to: 'madp8@example.com' }, template: 't/en', locals: {} })).message).subject;",
      'const first = await send();',
      "subject = 'Version two';",
      'await delivery.refresh();',
      'const second = await send();',
      'await delivery.close();',
      "process.stdout.write('MADP8 ' + JSON.stringify({ first, second }) + '\\n');"
    ].join('\n');
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 25000
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    const line = res.stdout.split('\n').find((l) => l.startsWith('MADP8 '));
    assert.ok(line, res.stdout + res.stderr);
    assert.deepStrictEqual(JSON.parse(line.slice(6)), { first: 'Version one', second: 'Version two' });
  });

  it('[MADP9] overlapping refreshes end with the templates read last, whatever finishes first', async () => {
    // reads: 0 = init, 1 = first refresh (slow), 2 = second refresh (fast)
    let reads = 0;
    const rows = (subject) => [{ type: 't', lang: 'en', part: 'subject', pug: '| ' + subject }, { type: 't', lang: 'en', part: 'html', pug: 'p x' }];
    delivery = await createEmailTemplatesDelivery({
      getAllMailTemplates: async () => {
        const n = reads++;
        if (n === 1) await new Promise((resolve) => setTimeout(resolve, 300));
        return rows('Version ' + n);
      },
      smtp: SMTP,
      from: FROM
    });
    await Promise.all([delivery.refresh(), delivery.refresh()]);
    const info = await delivery.send({ message: { to: 'madp9@example.com' }, template: 't/en', locals: {} });
    assert.strictEqual(JSON.parse(info.message).subject, 'Version 2');
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
