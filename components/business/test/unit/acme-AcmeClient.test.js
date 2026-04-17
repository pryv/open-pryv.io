/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 35 Phase 3 — AcmeClient wrapper.
 *
 * Uses a fake `acmeLib` that imitates the acme-client surface we care
 * about: .Client / .crypto / .directory. The real end-to-end flow is
 * covered by spike/level2-acme.js against Let's Encrypt staging.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const AcmeClient = require('../../src/acme/AcmeClient');

/** Make a CA-signed leaf PEM so parseValidity inside issueCert has real dates. */
function realCertBundle (cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pryv-ac-'));
  try {
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-noenc', '-keyout', keyPath, '-out', certPath,
      '-days', '90', '-subj', `/CN=${cn}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return fs.readFileSync(certPath, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fake acme-client that records calls and returns a stub bundle. */
function makeFakeLib (opts = {}) {
  const events = [];
  const lib = {
    directory: {
      letsencrypt: {
        staging: 'https://stub-staging.example/dir',
        production: 'https://stub-prod.example/dir'
      }
    },
    crypto: {
      async createPrivateKey () {
        events.push(['createPrivateKey']);
        return '-----BEGIN RSA PRIVATE KEY-----\nFAKE-ACCOUNT-KEY\n-----END RSA PRIVATE KEY-----';
      },
      async createCsr ({ commonName, altNames }) {
        events.push(['createCsr', commonName, altNames || null]);
        return [
          '-----BEGIN PRIVATE KEY-----\nFAKE-CERT-KEY-FOR-' + commonName + '\n-----END PRIVATE KEY-----',
          Buffer.from('csr-bytes-' + commonName)
        ];
      }
    },
    Client: class FakeClient {
      constructor (ctorOpts) {
        events.push(['Client.ctor', { directoryUrl: ctorOpts.directoryUrl, accountUrl: ctorOpts.accountUrl ?? null }]);
        this._opts = ctorOpts;
      }

      async createAccount (acctOpts) {
        events.push(['createAccount', acctOpts]);
        return { status: 'valid' };
      }

      getAccountUrl () {
        return opts.accountUrl || 'https://acme.example/acct/42';
      }

      async auto (autoOpts) {
        events.push(['auto', {
          challengePriority: autoOpts.challengePriority,
          hasChallengeCreate: typeof autoOpts.challengeCreateFn === 'function',
          hasChallengeRemove: typeof autoOpts.challengeRemoveFn === 'function'
        }]);
        // Exercise the challenge callbacks so tests can assert side effects.
        await autoOpts.challengeCreateFn({ identifier: { value: opts.identifierForChallenge || 'ex.com' } }, { type: 'dns-01' }, 'key-auth-value');
        await autoOpts.challengeRemoveFn({ identifier: { value: opts.identifierForChallenge || 'ex.com' } }, { type: 'dns-01' }, 'key-auth-value');
        return opts.bundlePem;
      }
    }
  };
  return { lib, events };
}

describe('[ACMECLIENT] AcmeClient', function () {
  this.timeout(10_000);

  before(function () {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch {
      console.log('  skipping: openssl not available');
      this.skip();
    }
  });

  describe('createAccount()', () => {
    it('returns { accountKey, accountUrl, email, directoryUrl }', async () => {
      const { lib, events } = makeFakeLib({ accountUrl: 'https://acme.example/acct/99' });
      const result = await AcmeClient.createAccount({
        email: 'ops@example.com',
        directoryUrl: 'https://custom.acme/dir',
        acmeLib: lib
      });
      assert.equal(result.email, 'ops@example.com');
      assert.equal(result.accountUrl, 'https://acme.example/acct/99');
      assert.equal(result.directoryUrl, 'https://custom.acme/dir');
      assert.match(result.accountKey, /BEGIN RSA PRIVATE KEY/);
      // Verify we created a private key, built a Client, and called createAccount
      assert.deepEqual(events[0], ['createPrivateKey']);
      assert.equal(events[1][0], 'Client.ctor');
      assert.equal(events[1][1].directoryUrl, 'https://custom.acme/dir');
      assert.equal(events[2][0], 'createAccount');
      assert.deepEqual(events[2][1].contact, ['mailto:ops@example.com']);
      assert.equal(events[2][1].termsOfServiceAgreed, true);
    });

    it('defaults directoryUrl to LE production', async () => {
      const { lib, events } = makeFakeLib();
      await AcmeClient.createAccount({ email: 'o@x.com', acmeLib: lib });
      assert.equal(events[1][1].directoryUrl, AcmeClient.DIRECTORY_PRODUCTION);
    });

    it('rejects missing email', async () => {
      const { lib } = makeFakeLib();
      await assert.rejects(AcmeClient.createAccount({ acmeLib: lib }), /email is required/);
    });
  });

  describe('issueCert()', () => {
    const account = {
      accountKey: '-----BEGIN RSA PRIVATE KEY-----\nK\n-----END RSA PRIVATE KEY-----',
      accountUrl: 'https://acme.example/acct/1'
    };

    it('returns the canonical {certPem, chainPem, keyPem, issuedAt, expiresAt} shape', async () => {
      const bundle = realCertBundle('example.test') + realCertBundle('intermediate');
      const { lib, events } = makeFakeLib({ bundlePem: bundle, identifierForChallenge: 'example.test' });

      const challenges = [];
      const result = await AcmeClient.issueCert({
        commonName: '*.example.test',
        altNames: ['example.test'],
        account,
        directoryUrl: 'https://stub/dir',
        challengeCreateFn: async (authz, challenge, keyAuth) => {
          challenges.push(['create', authz.identifier.value, keyAuth]);
        },
        challengeRemoveFn: async (authz, challenge, keyAuth) => {
          challenges.push(['remove', authz.identifier.value, keyAuth]);
        },
        acmeLib: lib
      });

      assert.equal(result.commonName, '*.example.test');
      assert.deepEqual(result.altNames, ['example.test']);
      assert.ok(result.certPem.includes('BEGIN CERTIFICATE'));
      assert.ok(!result.certPem.includes('BEGIN CERTIFICATE\n', 100), 'leaf should be single cert');
      assert.ok(result.chainPem.includes('BEGIN CERTIFICATE'), 'chain should carry intermediate');
      assert.ok(result.keyPem.includes('BEGIN PRIVATE KEY'));
      assert.ok(Number.isInteger(result.issuedAt));
      assert.ok(Number.isInteger(result.expiresAt));
      assert.ok(result.expiresAt > result.issuedAt);

      // Client was constructed with the passed account
      const ctorEvent = events.find(e => e[0] === 'Client.ctor');
      assert.equal(ctorEvent[1].accountUrl, account.accountUrl);
      assert.equal(ctorEvent[1].directoryUrl, 'https://stub/dir');

      // CSR built with the right names
      const csrEvent = events.find(e => e[0] === 'createCsr');
      assert.equal(csrEvent[1], '*.example.test');
      assert.deepEqual(csrEvent[2], ['example.test']);

      // auto() invoked once with dns-01 priority
      const autoEvent = events.find(e => e[0] === 'auto');
      assert.deepEqual(autoEvent[1].challengePriority, ['dns-01']);
      assert.equal(autoEvent[1].hasChallengeCreate, true);
      assert.equal(autoEvent[1].hasChallengeRemove, true);

      // Our callbacks were called by auto()
      assert.deepEqual(challenges, [
        ['create', 'example.test', 'key-auth-value'],
        ['remove', 'example.test', 'key-auth-value']
      ]);
    });

    it('works without altNames (single-host HTTP-01 style)', async () => {
      const bundle = realCertBundle('solo.test');
      const { lib, events } = makeFakeLib({ bundlePem: bundle });
      const result = await AcmeClient.issueCert({
        commonName: 'solo.test',
        account,
        challengeCreateFn: async () => {},
        challengeRemoveFn: async () => {},
        acmeLib: lib
      });
      assert.equal(result.commonName, 'solo.test');
      assert.deepEqual(result.altNames, []);
      // createCsr should NOT have been passed altNames when empty
      const csrEvent = events.find(e => e[0] === 'createCsr');
      assert.equal(csrEvent[2], null);
    });

    it('accepts a custom challengePriority (e.g. http-01)', async () => {
      const { lib, events } = makeFakeLib({ bundlePem: realCertBundle('h01.test') });
      await AcmeClient.issueCert({
        commonName: 'h01.test',
        account,
        challengePriority: ['http-01'],
        challengeCreateFn: async () => {},
        challengeRemoveFn: async () => {},
        acmeLib: lib
      });
      const autoEvent = events.find(e => e[0] === 'auto');
      assert.deepEqual(autoEvent[1].challengePriority, ['http-01']);
    });

    it('rejects missing required args', async () => {
      const { lib } = makeFakeLib();
      await assert.rejects(
        AcmeClient.issueCert({ acmeLib: lib }),
        /commonName is required/
      );
      await assert.rejects(
        AcmeClient.issueCert({ commonName: 'x', acmeLib: lib }),
        /account/
      );
      await assert.rejects(
        AcmeClient.issueCert({ commonName: 'x', account, acmeLib: lib }),
        /challengeCreateFn and challengeRemoveFn/
      );
    });

    it('defaults directoryUrl to LE production when omitted', async () => {
      const { lib, events } = makeFakeLib({ bundlePem: realCertBundle('d.test') });
      await AcmeClient.issueCert({
        commonName: 'd.test',
        account,
        challengeCreateFn: async () => {},
        challengeRemoveFn: async () => {},
        acmeLib: lib
      });
      const ctorEvent = events.find(e => e[0] === 'Client.ctor');
      assert.equal(ctorEvent[1].directoryUrl, AcmeClient.DIRECTORY_PRODUCTION);
    });
  });

  describe('exported constants', () => {
    it('expose LE directory URLs', () => {
      assert.equal(AcmeClient.DIRECTORY_STAGING, 'https://acme-staging-v02.api.letsencrypt.org/directory');
      assert.equal(AcmeClient.DIRECTORY_PRODUCTION, 'https://acme-v02.api.letsencrypt.org/directory');
    });
  });
});
