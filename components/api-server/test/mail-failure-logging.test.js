/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A mail sent after the response went out (welcome, MFA change, external-id
 * release, verification mail of an added address) that fails is logged once:
 * at warn when the SMTP server refused the recipient (user input) or deferred
 * it (a 4xx reply, temporary), at error for a transport or configuration
 * failure, and never as an unexpected error of a request that already
 * answered. A request that answers the client with the failure (password
 * reset) still does.
 *
 * The SMTP servers are small local ones that refuse every RCPT TO (one with a
 * 5xx, one with a 4xx reply), so the failure has the shape the real transport
 * gives it.
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
const { getConfig, getConfigSync, getLogger } = require('@pryv/boiler');
const { databaseFixture, injectTestConfigSnapshot } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');
const { getUsersRepository } = require('business/src/users/index.ts');
const { notifyMfaChange } = require('api-server/src/methods/helpers/mfaChange.ts');
const { notifyExternalIdReleased } = require('api-server/src/methods/helpers/externalIdRelease.ts');

const TRUSTED_APP = 'pryv-test-no-cors';
const MAIL_ON = { welcome: true, resetPassword: true, verifyEmail: true, mfaChange: true, externalIdReleased: true };
const REJECT_REPLY = '550 5.1.2 Recipient address rejected: Domain not found';
const DEFER_REPLY = '450 4.7.1 Recipient address rejected: Greylisted, try again later';

// The lines a failed send can produce: the sender's own, a caller's second
// log, or the failure wrapped as an unexpected error.
const FAILURE_LINE = /Sending email failed|mail not sent|notice .*not sent|failed \(add\)|unexpected-error/;

describe('[MLFL] failed mail sends are logged once, at the right level', function () {
  this.timeout(30000);

  let fixtures;
  let request;
  let restoreConfig;
  let template;
  let smtp;
  let deferringSmtp;

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
    // One template of our own serves every mail class, so a send gets as far
    // as the transport.
    template = 'mlfl-' + cuid.slug().toLowerCase();
    const platformDB = require('storages').platformDB;
    await platformDB.setMailTemplate(template, 'en', 'subject', '| Hello');
    await platformDB.setMailTemplate(template, 'en', 'html', 'p Hello');
    smtp = await rejectingSmtpServer(REJECT_REPLY);
    deferringSmtp = await rejectingSmtpServer(DEFER_REPLY);
  });

  after(async function () {
    await require('mail').close();
    if (smtp != null) await smtp.close();
    if (deferringSmtp != null) await deferringSmtp.close();
    restoreConfig();
    if (fixtures != null) await fixtures.context.cleanEverything();
  });

  beforeEach(async function () {
    // Each test starts with the in-process mail component not initialised,
    // so it picks up the transport the test configures.
    await require('mail').close();
  });

  /**
   * A local SMTP server that accepts the session and answers every RCPT TO
   * with `rcptReply`: a 5xx as a relay does for an address whose domain does
   * not exist, a 4xx as a greylisting relay does on first contact.
   */
  async function rejectingSmtpServer (rcptReply) {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.write('220 mlfl.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250 mlfl.test\r\n');
          else if (verb === 'MAIL') socket.write('250 2.1.0 Ok\r\n');
          else if (verb === 'RCPT') socket.write(rcptReply + '\r\n');
          else if (verb === 'RSET') socket.write('250 2.0.0 Ok\r\n');
          else if (verb === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); } else socket.write('502 5.5.2 Error: command not recognized\r\n');
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: server.address().port,
      close: () => new Promise((resolve) => server.close(resolve))
    };
  }

  async function closedPort () {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  function rejectingTransport () {
    return { host: '127.0.0.1', port: smtp.port, secure: false, ignoreTLS: true, connectionTimeout: 3000 };
  }

  function deferringTransport () {
    return { host: '127.0.0.1', port: deferringSmtp.port, secure: false, ignoreTLS: true, connectionTimeout: 3000 };
  }

  async function failingTransport () {
    return { host: '127.0.0.1', port: await closedPort(), connectionTimeout: 3000 };
  }

  function mailConfig (transport, overrides = {}) {
    return {
      services: {
        email: Object.assign({
          enabled: MAIL_ON,
          method: 'in-process',
          smtp: transport,
          welcomeTemplate: template,
          resetPasswordTemplate: template,
          verifyEmailTemplate: template,
          mfaChangeTemplate: template,
          externalIdReleasedTemplate: template
        }, overrides)
      }
    };
  }

  /**
   * Every log entry written while `fn` runs; then waits until a failure line
   * shows up (the sends run in the background) and a little longer, so a
   * second line, if any, is caught too.
   */
  async function captureLogs (fn) {
    const proto = Object.getPrototypeOf(getLogger('mlfl-capture'));
    const original = proto.log;
    const lines = [];
    proto.log = function (level, msg, ...rest) {
      // `_name` is a boiler internal: fall back so a rename does not throw here.
      lines.push({ level, name: typeof this._name === 'function' ? this._name() : this.name, text: String(msg) + (rest.length > 0 ? ' ' + inspect(rest, { depth: 6 }) : '') });
      return original.call(this, level, msg, ...rest);
    };
    try {
      await fn();
      for (let i = 0; i < 100 && !lines.some((l) => FAILURE_LINE.test(l.text)); i++) await setTimeout(50);
      await setTimeout(300);
    } finally {
      proto.log = original;
    }
    return lines;
  }

  function failureLines (lines) {
    return lines.filter((l) => l.level !== 'debug' && FAILURE_LINE.test(l.text));
  }

  function show (lines) {
    return JSON.stringify(lines.filter((l) => l.level !== 'debug'), null, 2);
  }

  /** Exactly one failure line, at warn, carrying the SMTP server's refusal. */
  function assertLoggedOnceAsRejected (lines) {
    const failures = failureLines(lines);
    assert.strictEqual(failures.length, 1, 'logged once: ' + show(lines));
    assert.strictEqual(failures[0].level, 'warn', show(lines));
    assert.match(failures[0].text, /recipient rejected/);
    assert.match(failures[0].text, /550 5\.1\.2/, 'the log carries the rejection reason');
    assert.deepStrictEqual(lines.filter((l) => l.level === 'error'), [], 'nothing at error: ' + show(lines));
  }

  /** Exactly one failure line, at warn, saying the recipient was deferred, with the reply. */
  function assertLoggedOnceAsDeferred (lines) {
    const failures = failureLines(lines);
    assert.strictEqual(failures.length, 1, 'logged once: ' + show(lines));
    assert.strictEqual(failures[0].level, 'warn', show(lines));
    assert.match(failures[0].text, /recipient deferred by the SMTP server \(temporary\), not sent and not retried/);
    assert.ok(!/recipient rejected/.test(failures[0].text), 'a deferral is not worded as a rejection: ' + show(lines));
    assert.match(failures[0].text, /450 4\.7\.1/, 'the log carries the server reply');
    assert.deepStrictEqual(lines.filter((l) => l.level === 'error'), [], 'nothing at error: ' + show(lines));
  }

  /** Exactly one failure line, at error, and not as an unexpected error. */
  function assertLoggedOnceAsError (lines, pattern) {
    const failures = failureLines(lines);
    assert.strictEqual(failures.length, 1, 'logged once: ' + show(lines));
    assert.strictEqual(failures[0].level, 'error', show(lines));
    assert.match(failures[0].text, pattern);
    assert.ok(!/unexpected-error/.test(failures[0].text), show(lines));
  }

  function registerBody () {
    return {
      username: 'mlfl' + cuid.slug().toLowerCase(),
      password: charlatan.Lorem.characters(9),
      email: 'mlfl-' + cuid.slug().toLowerCase() + '@does-not-exist.invalid',
      appId: charlatan.Lorem.characters(7),
      insurancenumber: charlatan.Number.number(3),
      phoneNumber: charlatan.Number.number(3),
      language: 'en'
    };
  }

  /** Register an account with every mail off; returns its name, id and token. */
  async function registerQuietly () {
    const restore = injectTestConfigSnapshot(mailConfig({ host: null }));
    try {
      const body = registerBody();
      const res = await request.post('/users').send(body);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const userId = await (await getUsersRepository()).getUserIdForUsername(body.username);
      const token = decodeURIComponent(new URL(res.body.apiEndpoint).username);
      assert.ok(token.length > 0, 'the api endpoint carries the token: ' + res.body.apiEndpoint);
      return { username: body.username, id: userId, token };
    } finally {
      restore();
    }
  }

  describe('[MLFL1] welcome mail', function () {
    it('[MLFL11] a refused recipient: 201, logged once at warn with the reason, no unexpected error', async function () {
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport()));
      try {
        const lines = await captureLogs(async () => {
          const res = await request.post('/users').send(registerBody());
          assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        });
        assertLoggedOnceAsRejected(lines);
      } finally {
        restore();
      }
    });

    it('[MLFL12] a transport failure: 201, logged once at error, no unexpected error', async function () {
      const restore = injectTestConfigSnapshot(mailConfig(await failingTransport()));
      try {
        const lines = await captureLogs(async () => {
          const res = await request.post('/users').send(registerBody());
          assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        });
        assertLoggedOnceAsError(lines, /Sending email failed \(in-process\)/);
      } finally {
        restore();
      }
    });

    it('[MLFL13] a missing template: 201, logged once at error, no unexpected error', async function () {
      const missing = 'mlfl-missing-' + cuid.slug().toLowerCase();
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport(), { welcomeTemplate: missing }));
      try {
        const lines = await captureLogs(async () => {
          const res = await request.post('/users').send(registerBody());
          assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        });
        assertLoggedOnceAsError(lines, /no template found for mlfl-missing-/);
      } finally {
        restore();
      }
    });

    it('[MLFL14] a recipient deferred with a 4xx reply (greylisting): 201, logged once at warn as deferred, no unexpected error', async function () {
      const restore = injectTestConfigSnapshot(mailConfig(deferringTransport()));
      try {
        const lines = await captureLogs(async () => {
          const res = await request.post('/users').send(registerBody());
          assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        });
        assertLoggedOnceAsDeferred(lines);
      } finally {
        restore();
      }
    });
  });

  describe('[MLFL2] other mails sent in the background', function () {
    it('[MLFL21] MFA change notice: a refused recipient is logged once at warn', async function () {
      const user = await registerQuietly();
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport()));
      try {
        const lines = await captureLogs(async () => {
          notifyMfaChange(getConfigSync(), user, 'enrolled');
        });
        assertLoggedOnceAsRejected(lines);
      } finally {
        restore();
      }
    });

    it('[MLFL22] MFA change notice: a transport failure is logged once at error', async function () {
      const user = await registerQuietly();
      const restore = injectTestConfigSnapshot(mailConfig(await failingTransport()));
      try {
        const lines = await captureLogs(async () => {
          notifyMfaChange(getConfigSync(), user, 'enrolled');
        });
        assertLoggedOnceAsError(lines, /Sending email failed \(in-process\)/);
      } finally {
        restore();
      }
    });

    it('[MLFL23] external-id release notice: a refused recipient is logged once at warn, the release reports audit-only', async function () {
      const user = await registerQuietly();
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport()));
      try {
        let outcome;
        const lines = await captureLogs(async () => {
          outcome = await notifyExternalIdReleased(getConfigSync(), user, { namespaceLabel: 'Clinic', reason: 'test' });
        });
        assert.strictEqual(outcome, 'audit-only');
        assertLoggedOnceAsRejected(lines);
      } finally {
        restore();
      }
    });

    it('[MLFL24] verification mail of an added address: the update succeeds, a refused recipient is logged once at warn', async function () {
      const user = await registerQuietly();
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport()));
      try {
        const lines = await captureLogs(async () => {
          const res = await request.put('/' + user.username + '/account').set('Authorization', user.token)
            .send({ emails: { add: ['mlfl-' + cuid.slug().toLowerCase() + '@does-not-exist.invalid'] } });
          assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        });
        assertLoggedOnceAsRejected(lines);
      } finally {
        restore();
      }
    });
  });

  describe('[MLFL3] a request that answers with the failure', function () {
    it('[MLFL31] password reset to a refused recipient still answers the client with the generic mail error', async function () {
      const user = await registerQuietly();
      const restore = injectTestConfigSnapshot(mailConfig(rejectingTransport()));
      try {
        let res;
        const lines = await captureLogs(async () => {
          res = await request.post('/' + user.username + '/account/request-password-reset')
            .set('Origin', 'http://test.pryv.local').send({ appId: TRUSTED_APP });
        });
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.match(res.body.error.message, /Sending email failed\. Please try again later or contact support\./);
        assert.ok(!/550|Domain not found/.test(JSON.stringify(res.body)), 'the SMTP reply stays out of the answer');
        const senderLines = lines.filter((l) => /Sending email failed \(in-process\)/.test(l.text));
        assert.strictEqual(senderLines.length, 1, show(lines));
        assert.strictEqual(senderLines[0].level, 'warn', show(lines));
      } finally {
        restore();
      }
    });

    /** A 400 naming the refused address, without the SMTP reply, logged once at warn by the sender only. */
    function assertRecipientRejectedAnswer (res, lines, email) {
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-parameters-format', JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.error.data, { email, reason: 'recipient-rejected' });
      assert.ok(!/550|Domain not found/.test(JSON.stringify(res.body)), 'the SMTP reply stays out of the answer');
      assertLoggedOnceAsRejected(lines);
    }

    /** Add an address to the account with mail switched off, so only the resend sends. */
    async function addAddressQuietly (user, email) {
      const restore = injectTestConfigSnapshot(mailConfig({ host: null }));
      try {
        const res = await request.put('/' + user.username + '/account').set('Authorization', user.token)
          .send({ emails: { add: [email] } });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      } finally {
        restore();
      }
    }

    function resendConfig (transport) {
      return Object.assign(mailConfig(transport), { account: { emailVerification: { requireAtRegistration: false, resendCooldownMs: 0 } } });
    }

    it('[MLFL32] verification resend to a refused recipient answers 400 recipient-rejected (the address is the caller\'s input)', async function () {
      const user = await registerQuietly();
      const email = 'mlfl-' + cuid.slug().toLowerCase() + '@does-not-exist.invalid';
      await addAddressQuietly(user, email);
      const restore = injectTestConfigSnapshot(resendConfig(rejectingTransport()));
      try {
        let res;
        const lines = await captureLogs(async () => {
          res = await request.put('/' + user.username + '/account').set('Authorization', user.token)
            .send({ emails: { resend: [email] } });
        });
        assertRecipientRejectedAnswer(res, lines, email);
      } finally {
        restore();
      }
    });

    it('[MLFL33] verification resend to a deferred recipient (4xx, temporary) still answers the generic mail error', async function () {
      const user = await registerQuietly();
      const email = 'mlfl-' + cuid.slug().toLowerCase() + '@does-not-exist.invalid';
      await addAddressQuietly(user, email);
      const restore = injectTestConfigSnapshot(resendConfig(deferringTransport()));
      try {
        let res;
        await captureLogs(async () => {
          res = await request.put('/' + user.username + '/account').set('Authorization', user.token)
            .send({ emails: { resend: [email] } });
        });
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.match(res.body.error.message, /Sending email failed\. Please try again later or contact support\./);
      } finally {
        restore();
      }
    });

    it('[MLFL34] registration email code to a refused recipient answers 400 recipient-rejected', async function () {
      const email = 'mlfl-' + cuid.slug().toLowerCase() + '@does-not-exist.invalid';
      const restore = injectTestConfigSnapshot(Object.assign(mailConfig(rejectingTransport(), { emailChallengeTemplate: template }), {
        account: { emailVerification: { requireAtRegistration: true, registrationCodeResendCooldownMs: 0 } }
      }));
      try {
        let res;
        const lines = await captureLogs(async () => {
          res = await request.post('/reg/email-challenge').send({ email });
        });
        assertRecipientRejectedAnswer(res, lines, email);
      } finally {
        restore();
      }
    });
  });
});
