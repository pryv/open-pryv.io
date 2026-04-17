/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PlatformDB conformance test suite.
 * @param {Function} getDB - async function returning an initialized PlatformDB instance
 */
module.exports = function conformanceTests (getDB) {
  const assert = require('node:assert');
  const cuid = require('cuid');

  describe('PlatformDB conformance', () => {
    let db;

    before(async () => {
      db = await getDB();
    });

    afterEach(async () => {
      await db.deleteAll();
    });

    describe('setUserUniqueField() / getUsersUniqueField()', () => {
      it('must set and retrieve a unique field', async () => {
        const username = 'user-' + cuid();
        const email = 'test-' + cuid() + '@example.com';
        await db.setUserUniqueField(username, 'email', email);

        const result = await db.getUsersUniqueField('email', email);
        assert.strictEqual(result, username);
      });

      it('must return null for non-existing unique field', async () => {
        const result = await db.getUsersUniqueField('email', 'nonexist-' + cuid());
        assert.strictEqual(result, null);
      });
    });

    describe('setUserUniqueFieldIfNotExists()', () => {
      it('must set a new unique field and return true', async () => {
        const username = 'user-' + cuid();
        const email = 'ifne-' + cuid() + '@example.com';
        const result = await db.setUserUniqueFieldIfNotExists(username, 'email', email);
        assert.strictEqual(result, true);

        const stored = await db.getUsersUniqueField('email', email);
        assert.strictEqual(stored, username);
      });

      it('must return false when field already exists for different user', async () => {
        const user1 = 'user1-' + cuid();
        const user2 = 'user2-' + cuid();
        const email = 'dup-' + cuid() + '@example.com';

        await db.setUserUniqueFieldIfNotExists(user1, 'email', email);
        const result = await db.setUserUniqueFieldIfNotExists(user2, 'email', email);
        assert.strictEqual(result, false);

        // Original value unchanged
        const stored = await db.getUsersUniqueField('email', email);
        assert.strictEqual(stored, user1);
      });

      it('must return true when re-setting for the same user', async () => {
        const username = 'user-' + cuid();
        const email = 'same-' + cuid() + '@example.com';

        await db.setUserUniqueFieldIfNotExists(username, 'email', email);
        const result = await db.setUserUniqueFieldIfNotExists(username, 'email', email);
        assert.strictEqual(result, true);
      });
    });

    describe('setUserIndexedField() / getUserIndexedField()', () => {
      it('must set and retrieve an indexed field', async () => {
        const username = 'user-' + cuid();
        await db.setUserIndexedField(username, 'lang', 'en');

        const result = await db.getUserIndexedField(username, 'lang');
        assert.strictEqual(result, 'en');
      });

      it('must return null for non-existing indexed field', async () => {
        const result = await db.getUserIndexedField('nonexist-' + cuid(), 'lang');
        assert.strictEqual(result, null);
      });
    });

    describe('deleteUserUniqueField()', () => {
      it('must delete a unique field', async () => {
        const username = 'user-' + cuid();
        const email = 'del-' + cuid() + '@example.com';
        await db.setUserUniqueField(username, 'email', email);
        await db.deleteUserUniqueField('email', email);

        const result = await db.getUsersUniqueField('email', email);
        assert.strictEqual(result, null);
      });
    });

    describe('deleteUserIndexedField()', () => {
      it('must delete an indexed field', async () => {
        const username = 'user-' + cuid();
        await db.setUserIndexedField(username, 'lang', 'fr');
        await db.deleteUserIndexedField(username, 'lang');

        const result = await db.getUserIndexedField(username, 'lang');
        assert.strictEqual(result, null);
      });
    });

    describe('getAllWithPrefix()', () => {
      it('must return all entries', async () => {
        const u1 = 'user1-' + cuid();
        const u2 = 'user2-' + cuid();
        await db.setUserUniqueField(u1, 'email', u1 + '@test.com');
        await db.setUserIndexedField(u2, 'lang', 'de');

        const all = await db.getAllWithPrefix('user');
        assert.ok(Array.isArray(all));
        assert.ok(all.length >= 2);
      });
    });

    describe('deleteAll()', () => {
      it('must delete all entries', async () => {
        await db.setUserIndexedField('u-' + cuid(), 'lang', 'en');
        await db.deleteAll();

        const all = await db.getAllWithPrefix('user');
        assert.strictEqual(all.length, 0);
      });
    });

    describe('close() / isClosed()', () => {
      it('isClosed() must return false when open', () => {
        assert.strictEqual(db.isClosed(), false);
      });
    });

    describe('setUserCore() / getUserCore()', () => {
      it('must set and retrieve a user-to-core mapping', async () => {
        const username = 'user-' + cuid();
        const coreId = 'core-' + cuid().slice(0, 6);
        await db.setUserCore(username, coreId);

        const result = await db.getUserCore(username);
        assert.strictEqual(result, coreId);
      });

      it('must return null for unknown user', async () => {
        const result = await db.getUserCore('nonexist-' + cuid());
        assert.strictEqual(result, null);
      });

      it('must overwrite existing mapping', async () => {
        const username = 'user-' + cuid();
        await db.setUserCore(username, 'core-a');
        await db.setUserCore(username, 'core-b');

        const result = await db.getUserCore(username);
        assert.strictEqual(result, 'core-b');
      });
    });

    describe('getAllUserCores()', () => {
      it('must return all user-to-core mappings', async () => {
        const u1 = 'user1-' + cuid();
        const u2 = 'user2-' + cuid();
        await db.setUserCore(u1, 'core-a');
        await db.setUserCore(u2, 'core-b');

        const all = await db.getAllUserCores();
        assert.ok(Array.isArray(all));
        assert.ok(all.length >= 2);
        const u1Entry = all.find(e => e.username === u1);
        assert.ok(u1Entry, 'user1 mapping found');
        assert.strictEqual(u1Entry.coreId, 'core-a');
        const u2Entry = all.find(e => e.username === u2);
        assert.ok(u2Entry, 'user2 mapping found');
        assert.strictEqual(u2Entry.coreId, 'core-b');
      });

      it('must return empty array when no mappings', async () => {
        const all = await db.getAllUserCores();
        assert.ok(Array.isArray(all));
        assert.strictEqual(all.length, 0);
      });
    });

    describe('setCoreInfo() / getCoreInfo() / getAllCoreInfos()', () => {
      it('must set and retrieve core info', async () => {
        const info = { id: 'core-a', ip: '1.2.3.4', hosting: 'hosting-1', available: true };
        await db.setCoreInfo('core-a', info);

        const result = await db.getCoreInfo('core-a');
        assert.deepStrictEqual(result, info);
      });

      it('must return null for unknown core', async () => {
        const result = await db.getCoreInfo('nonexist-' + cuid());
        assert.strictEqual(result, null);
      });

      it('must overwrite existing core info', async () => {
        const info1 = { id: 'core-x', available: true };
        const info2 = { id: 'core-x', available: false };
        await db.setCoreInfo('core-x', info1);
        await db.setCoreInfo('core-x', info2);

        const result = await db.getCoreInfo('core-x');
        assert.strictEqual(result.available, false);
      });

      it('must return all registered cores', async () => {
        await db.setCoreInfo('core-1', { id: 'core-1', hosting: 'h1', available: true });
        await db.setCoreInfo('core-2', { id: 'core-2', hosting: 'h1', available: false });

        const all = await db.getAllCoreInfos();
        assert.ok(Array.isArray(all));
        assert.ok(all.length >= 2);
        assert.ok(all.find(c => c.id === 'core-1'));
        assert.ok(all.find(c => c.id === 'core-2'));
      });
    });

    describe('migration methods', () => {
      it('exportAll() must return data from getAllWithPrefix', async () => {
        const u = 'exp-' + cuid();
        await db.setUserIndexedField(u, 'lang', 'it');
        const exported = await db.exportAll();
        assert.ok(Array.isArray(exported));
        assert.ok(exported.length >= 1);
      });

      it('importAll() must import entries', async () => {
        const u = 'imp-' + cuid();
        const email = 'imp-' + cuid() + '@test.com';
        await db.importAll([
          { isUnique: true, username: u, field: 'email', value: email },
          { isUnique: false, username: u, field: 'lang', value: 'ja' }
        ]);

        const uniqueResult = await db.getUsersUniqueField('email', email);
        assert.strictEqual(uniqueResult, u);
        const indexedResult = await db.getUserIndexedField(u, 'lang');
        assert.strictEqual(indexedResult, 'ja');
      });

      it('clearAll() must remove all data', async () => {
        await db.setUserIndexedField('clr-' + cuid(), 'lang', 'pt');
        await db.clearAll();

        const all = await db.getAllWithPrefix('user');
        assert.strictEqual(all.length, 0);
      });
    });

    describe('setDnsRecord / getDnsRecord / getAllDnsRecords / deleteDnsRecord', () => {
      it('must set and retrieve a DNS record', async () => {
        const subdomain = '_acme-' + cuid();
        const records = { txt: ['token-' + cuid()] };
        await db.setDnsRecord(subdomain, records);

        const stored = await db.getDnsRecord(subdomain);
        assert.deepStrictEqual(stored, records);
      });

      it('must return null for an unknown DNS record', async () => {
        const result = await db.getDnsRecord('missing-' + cuid());
        assert.strictEqual(result, null);
      });

      it('must overwrite an existing DNS record', async () => {
        const subdomain = '_acme-' + cuid();
        await db.setDnsRecord(subdomain, { txt: ['first'] });
        await db.setDnsRecord(subdomain, { txt: ['second'] });
        const stored = await db.getDnsRecord(subdomain);
        assert.deepStrictEqual(stored, { txt: ['second'] });
      });

      it('getAllDnsRecords() must return every persisted record', async () => {
        const sub1 = '_all1-' + cuid();
        const sub2 = '_all2-' + cuid();
        await db.setDnsRecord(sub1, { txt: ['a'] });
        await db.setDnsRecord(sub2, { cname: 'target.example.com' });

        const all = await db.getAllDnsRecords();
        const found1 = all.find(r => r.subdomain === sub1);
        const found2 = all.find(r => r.subdomain === sub2);
        assert.ok(found1, 'subdomain 1 missing from getAllDnsRecords');
        assert.deepStrictEqual(found1.records, { txt: ['a'] });
        assert.ok(found2, 'subdomain 2 missing from getAllDnsRecords');
        assert.deepStrictEqual(found2.records, { cname: 'target.example.com' });
      });

      it('deleteDnsRecord() must remove the record', async () => {
        const subdomain = '_del-' + cuid();
        await db.setDnsRecord(subdomain, { txt: ['gone'] });
        await db.deleteDnsRecord(subdomain);
        const stored = await db.getDnsRecord(subdomain);
        assert.strictEqual(stored, null);
      });

      it('setDnsRecord must not interfere with user-unique keys (namespace isolation)', async () => {
        const subdomain = '_iso-' + cuid();
        const email = 'iso-' + cuid() + '@test.com';
        await db.setUserUniqueField('u-' + cuid(), 'email', email);
        await db.setDnsRecord(subdomain, { txt: ['x'] });

        const dns = await db.getDnsRecord(subdomain);
        assert.deepStrictEqual(dns, { txt: ['x'] });
        const userEmail = await db.getUsersUniqueField('email', email);
        assert.ok(userEmail);
      });
    });

    describe('setAcmeAccount / getAcmeAccount', () => {
      it('must persist and retrieve a singleton ACME account', async () => {
        const account = {
          accountKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
          accountUrl: 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/123456',
          email: 'ops-' + cuid() + '@example.com'
        };
        await db.setAcmeAccount(account);
        const stored = await db.getAcmeAccount();
        assert.deepStrictEqual(stored, account);
      });

      it('must overwrite an existing ACME account on re-set', async () => {
        await db.setAcmeAccount({ accountKey: 'k1', accountUrl: 'u1', email: 'a@x.com' });
        await db.setAcmeAccount({ accountKey: 'k2', accountUrl: 'u2', email: 'b@x.com' });
        const stored = await db.getAcmeAccount();
        assert.strictEqual(stored.accountKey, 'k2');
        assert.strictEqual(stored.email, 'b@x.com');
      });
    });

    describe('setCertificate / getCertificate / listCertificates / deleteCertificate', () => {
      function makeCert (issuedAt, expiresAt) {
        return {
          certPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
          chainPem: '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----',
          keyPem: '-----BEGIN PRIVATE KEY-----\nCCC\n-----END PRIVATE KEY-----',
          issuedAt,
          expiresAt
        };
      }

      it('must persist and retrieve a certificate by hostname', async () => {
        const host = 'host-' + cuid() + '.example.com';
        const cert = makeCert(1000, 2000);
        await db.setCertificate(host, cert);
        const stored = await db.getCertificate(host);
        assert.deepStrictEqual(stored, cert);
      });

      it('must return null for an unknown hostname', async () => {
        const result = await db.getCertificate('unknown-' + cuid());
        assert.strictEqual(result, null);
      });

      it('must overwrite an existing certificate (renewal)', async () => {
        const host = 'renew-' + cuid() + '.example.com';
        await db.setCertificate(host, makeCert(1000, 2000));
        await db.setCertificate(host, makeCert(3000, 4000));
        const stored = await db.getCertificate(host);
        assert.strictEqual(stored.issuedAt, 3000);
        assert.strictEqual(stored.expiresAt, 4000);
      });

      it('supports wildcard hostnames as literal keys', async () => {
        const host = '*.wildcard-' + cuid() + '.example.com';
        await db.setCertificate(host, makeCert(1000, 2000));
        const stored = await db.getCertificate(host);
        assert.ok(stored);
        assert.strictEqual(stored.issuedAt, 1000);
      });

      it('listCertificates() returns metadata without PEM bodies', async () => {
        const host1 = 'list1-' + cuid() + '.example.com';
        const host2 = 'list2-' + cuid() + '.example.com';
        await db.setCertificate(host1, makeCert(100, 200));
        await db.setCertificate(host2, makeCert(300, 400));

        const all = await db.listCertificates();
        const found1 = all.find(r => r.hostname === host1);
        const found2 = all.find(r => r.hostname === host2);
        assert.ok(found1, host1 + ' missing from listCertificates');
        assert.ok(found2, host2 + ' missing from listCertificates');
        assert.deepStrictEqual(found1, { hostname: host1, issuedAt: 100, expiresAt: 200 });
        assert.deepStrictEqual(found2, { hostname: host2, issuedAt: 300, expiresAt: 400 });
        // No PEM body leaking through
        assert.strictEqual(found1.certPem, undefined);
        assert.strictEqual(found1.keyPem, undefined);
      });

      it('deleteCertificate() removes the record', async () => {
        const host = 'del-' + cuid() + '.example.com';
        await db.setCertificate(host, makeCert(1000, 2000));
        await db.deleteCertificate(host);
        const stored = await db.getCertificate(host);
        assert.strictEqual(stored, null);
      });

      it('cert namespace does not collide with dns-record or user-unique keys', async () => {
        const host = 'iso-' + cuid() + '.example.com';
        const sub = '_iso-' + cuid();
        const email = 'iso-' + cuid() + '@example.com';
        await db.setCertificate(host, makeCert(1000, 2000));
        await db.setDnsRecord(sub, { txt: ['x'] });
        await db.setUserUniqueField('u-' + cuid(), 'email', email);

        assert.ok(await db.getCertificate(host));
        assert.ok(await db.getDnsRecord(sub));
        assert.ok(await db.getUsersUniqueField('email', email));
      });
    });
  });
};
