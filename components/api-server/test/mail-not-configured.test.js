/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-process mail with no SMTP host means "mail not configured": the welcome
 * and password-reset mails are skipped quietly (the boot warns once), never
 * logged as an unexpected error. With an SMTP host whose transport fails, the
 * failure is still logged as an error.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const net = require('node:net');
const { inspect } = require('node:util');
const charlatan = require('charlatan');
const cuid = require('cuid');
const { setTimeout } = require('node:timers/promises');
const { listeningAgent } = require('test-helpers');

const { getApplication } = require('api-server/src/application.ts');
const { getConfig, getLogger } = require('@pryv/boiler');
const { databaseFixture, injectTestConfigSnapshot } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');

const TRUSTED_APP = 'pryv-test-no-cors';
const MAIL_ON = { welcome: true, resetPassword: true, verifyEmail: false, mfaChange: false };

describe('[MLNC] mail not configured', function () {
  this.timeout(30000);

  let fixtures;
  let request;
  let restoreConfig;
  let welcomeTemplate;

  before(async function () {
    await getConfig();
    restoreConfig = injectTestConfigSnapshot({
      dnsLess: { isActive: true },
      custom: { systemStreams: null },
      account: { emailVerification: { requireAtRegistration: false } }
    });
    fixtures = databaseFixture(await produceStorageConnection());
    const app = getApplication(true);
    await app.initiate();
    await require('api-server/src/methods/auth/register.ts').default(app.api);
    await require('api-server/src/methods/account.ts').default(app.api);
    pubsub.setTestNotifier({ emit: () => {} });
    request = await listeningAgent(app.expressApp);
    // A template of our own, so a send gets as far as the transport.
    welcomeTemplate = 'mlnc-welcome-' + cuid.slug().toLowerCase();
    const platformDB = require('storages').platformDB;
    await platformDB.setMailTemplate(welcomeTemplate, 'en', 'subject', '| Welcome');
    await platformDB.setMailTemplate(welcomeTemplate, 'en', 'html', 'p Welcome');
  });

  after(async function () {
    await require('mail').close();
    restoreConfig();
    if (fixtures != null) await fixtures.context.cleanEverything();
  });

  beforeEach(async function () {
    // Each test starts with the in-process mail component not initialised,
    // as in a worker that has not sent any mail yet.
    await require('mail').close();
  });

  /** Every log entry written while `fn` runs, plus `settleMs` after it. */
  async function captureLogs (fn, settleMs) {
    const proto = Object.getPrototypeOf(getLogger('mlnc-capture'));
    const original = proto.log;
    const lines = [];
    proto.log = function (level, msg, ...rest) {
      lines.push({ level, name: this._name(), text: String(msg) + (rest.length > 0 ? ' ' + inspect(rest, { depth: 6 }) : '') });
      return original.call(this, level, msg, ...rest);
    };
    try {
      await fn(lines);
      await setTimeout(settleMs);
    } finally {
      proto.log = original;
    }
    return lines;
  }

  function registerBody () {
    return {
      username: 'mlnc' + cuid.slug().toLowerCase(),
      password: charlatan.Lorem.characters(9),
      email: 'mlnc-' + cuid.slug().toLowerCase() + '@test.com',
      appId: charlatan.Lorem.characters(7),
      insurancenumber: charlatan.Number.number(3),
      phoneNumber: charlatan.Number.number(3),
      language: 'en'
    };
  }

  function mailConfig (smtp) {
    return { services: { email: { enabled: MAIL_ON, method: 'in-process', smtp, welcomeTemplate, resetPasswordTemplate: welcomeTemplate } } };
  }

  async function closedPort () {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it('[MLNC1] with no SMTP host, registration and password reset succeed and log no error', async function () {
    const restore = injectTestConfigSnapshot(mailConfig({ host: null }));
    try {
      const body = registerBody();
      const lines = await captureLogs(async () => {
        const res = await request.post('/users').send(body);
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        const reset = await request.post('/' + body.username + '/account/request-password-reset')
          .set('Origin', 'http://test.pryv.local').send({ appId: TRUSTED_APP });
        assert.strictEqual(reset.status, 200, JSON.stringify(reset.body));
      }, 500);
      const errors = lines.filter((l) => l.level === 'error' || /unexpected-error|Sending email failed/.test(l.text));
      assert.deepStrictEqual(errors, [], JSON.stringify(errors));
      assert.ok(lines.some((l) => l.level === 'debug' && /Mail not configured/.test(l.text)), 'the skip is logged at debug');
      assert.strictEqual(require('mail').isActive(), false, 'no transport was set up');
    } finally {
      restore();
    }
  });

  it('[MLNC2] with an SMTP host whose transport fails, the failure is still logged as an error', async function () {
    const restore = injectTestConfigSnapshot(mailConfig({ host: '127.0.0.1', port: await closedPort(), connectionTimeout: 3000 }));
    try {
      const lines = await captureLogs(async (seen) => {
        const res = await request.post('/users').send(registerBody());
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        for (let i = 0; i < 100; i++) {
          if (seen.some((l) => /Sending email failed/.test(l.text))) return;
          await setTimeout(50);
        }
      }, 0);
      assert.ok(lines.some((l) => l.level === 'error' && /Sending email failed \(in-process\)/.test(l.text)),
        JSON.stringify(lines.filter((l) => l.level !== 'debug')));
    } finally {
      restore();
    }
  });
});
