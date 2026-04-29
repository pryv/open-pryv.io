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

    describe('setObservabilityValue / getObservabilityValue / getAllObservabilityValues / deleteObservabilityValue', () => {
      it('must persist and retrieve a value by key', async () => {
        const key = 'enabled-' + cuid();
        await db.setObservabilityValue(key, 'true');
        const stored = await db.getObservabilityValue(key);
        assert.strictEqual(stored, 'true');
      });

      it('must return null for an unknown key', async () => {
        const result = await db.getObservabilityValue('unknown-' + cuid());
        assert.strictEqual(result, null);
      });

      it('must overwrite an existing value (rotation)', async () => {
        const key = 'license-' + cuid();
        await db.setObservabilityValue(key, 'old-key');
        await db.setObservabilityValue(key, 'new-key');
        const stored = await db.getObservabilityValue(key);
        assert.strictEqual(stored, 'new-key');
      });

      it('getAllObservabilityValues() returns every row stripped of the prefix', async () => {
        const suffix = cuid();
        const k1 = 'bulk1-' + suffix;
        const k2 = 'bulk2-' + suffix;
        await db.setObservabilityValue(k1, 'v1');
        await db.setObservabilityValue(k2, 'v2');
        const all = await db.getAllObservabilityValues();
        const f1 = all.find(r => r.key === k1);
        const f2 = all.find(r => r.key === k2);
        assert.ok(f1, k1 + ' missing');
        assert.ok(f2, k2 + ' missing');
        assert.strictEqual(f1.value, 'v1');
        assert.strictEqual(f2.value, 'v2');
      });

      it('deleteObservabilityValue() removes the row', async () => {
        const key = 'del-' + cuid();
        await db.setObservabilityValue(key, 'x');
        await db.deleteObservabilityValue(key);
        const stored = await db.getObservabilityValue(key);
        assert.strictEqual(stored, null);
      });

      it('observability namespace does not collide with dns-record or user-core keys', async () => {
        const suffix = cuid();
        const obsKey = 'nocoll-' + suffix;
        const obsValue = 'obs-value-' + suffix;
        await db.setObservabilityValue(obsKey, obsValue);
        await db.setDnsRecord('_nocoll-' + suffix, { txt: ['x'] });
        await db.setUserCore('nocoll-' + suffix, 'core-a');

        assert.strictEqual(await db.getObservabilityValue(obsKey), obsValue);
        assert.ok(await db.getDnsRecord('_nocoll-' + suffix));
        assert.strictEqual(await db.getUserCore('nocoll-' + suffix), 'core-a');
      });
    });

    describe('[MAILTMPL] setMailTemplate / getMailTemplate / getAllMailTemplates / deleteMailTemplate', () => {
      it('[MT01] must persist and retrieve a {type, lang, part} triple', async () => {
        const t = 'welcome-' + cuid();
        await db.setMailTemplate(t, 'en', 'subject', '| Welcome');
        await db.setMailTemplate(t, 'en', 'html', 'p Hello #{username}.');
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'subject'), '| Welcome');
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'html'), 'p Hello #{username}.');
      });

      it('[MT02] must return null for absent rows', async () => {
        const t = 'missing-' + cuid();
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'subject'), null);
      });

      it('[MT03] must overwrite existing values (edit path)', async () => {
        const t = 'rewrite-' + cuid();
        await db.setMailTemplate(t, 'fr', 'html', 'p Bonjour');
        await db.setMailTemplate(t, 'fr', 'html', 'p Salut');
        assert.strictEqual(await db.getMailTemplate(t, 'fr', 'html'), 'p Salut');
      });

      it('[MT04] getAllMailTemplates() returns rows decoded to {type, lang, part, pug}', async () => {
        const t = 'bulk-' + cuid();
        await db.setMailTemplate(t, 'en', 'subject', 'S-en');
        await db.setMailTemplate(t, 'en', 'html', 'H-en');
        await db.setMailTemplate(t, 'fr', 'subject', 'S-fr');

        const all = await db.getAllMailTemplates();
        const mine = all.filter(r => r.type === t);
        assert.strictEqual(mine.length, 3);
        const byKey = new Map(mine.map(r => [r.lang + '/' + r.part, r.pug]));
        assert.strictEqual(byKey.get('en/subject'), 'S-en');
        assert.strictEqual(byKey.get('en/html'), 'H-en');
        assert.strictEqual(byKey.get('fr/subject'), 'S-fr');
      });

      it('[MT05] deleteMailTemplate(type, lang, part) removes only that row', async () => {
        const t = 'del-one-' + cuid();
        await db.setMailTemplate(t, 'en', 'subject', 'S');
        await db.setMailTemplate(t, 'en', 'html', 'H');
        await db.deleteMailTemplate(t, 'en', 'subject');
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'subject'), null);
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'html'), 'H');
      });

      it('[MT06] deleteMailTemplate(type, lang) with no part wipes both html + subject for that lang only', async () => {
        const t = 'del-lang-' + cuid();
        await db.setMailTemplate(t, 'en', 'subject', 'S-en');
        await db.setMailTemplate(t, 'en', 'html', 'H-en');
        await db.setMailTemplate(t, 'fr', 'subject', 'S-fr');
        await db.setMailTemplate(t, 'fr', 'html', 'H-fr');

        await db.deleteMailTemplate(t, 'en');
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'subject'), null);
        assert.strictEqual(await db.getMailTemplate(t, 'en', 'html'), null);
        assert.strictEqual(await db.getMailTemplate(t, 'fr', 'subject'), 'S-fr');
        assert.strictEqual(await db.getMailTemplate(t, 'fr', 'html'), 'H-fr');
      });

      it('[MT07] mail-template namespace is isolated from dns-record, user-core, observability', async () => {
        const suffix = cuid();
        const type = 'iso-' + suffix;
        await db.setMailTemplate(type, 'en', 'subject', 'mail-value');
        await db.setDnsRecord('_iso-' + suffix, { txt: ['x'] });
        await db.setUserCore('iso-' + suffix, 'core-a');
        await db.setObservabilityValue('iso-' + suffix, 'obs-value');

        assert.strictEqual(await db.getMailTemplate(type, 'en', 'subject'), 'mail-value');
        assert.ok(await db.getDnsRecord('_iso-' + suffix));
        assert.strictEqual(await db.getUserCore('iso-' + suffix), 'core-a');
        assert.strictEqual(await db.getObservabilityValue('iso-' + suffix), 'obs-value');
      });
    });

    describe('[ACCESSSTATE] setAccessState / getAccessState / deleteAccessState / sweepExpiredAccessStates', () => {
      const future = () => Date.now() + 60_000;
      const past = () => Date.now() - 1_000;

      it('[AS01] set + get round-trips the value with expiresAt', async () => {
        const key = 'k-' + cuid();
        const value = { status: 'NEED_SIGNIN', requestingAppId: 'app' };
        const expiresAt = future();
        await db.setAccessState(key, value, expiresAt);
        const got = await db.getAccessState(key);
        assert.deepStrictEqual(got.value, value);
        assert.strictEqual(got.expiresAt, expiresAt);
      });

      it('[AS02] get returns null for an unknown key', async () => {
        assert.strictEqual(await db.getAccessState('missing-' + cuid()), null);
      });

      it('[AS03] set replaces an existing value (idempotent upsert)', async () => {
        const key = 'k-' + cuid();
        const exp = future();
        await db.setAccessState(key, { v: 1 }, exp);
        await db.setAccessState(key, { v: 2 }, exp);
        const got = await db.getAccessState(key);
        assert.deepStrictEqual(got.value, { v: 2 });
      });

      it('[AS04] get on an expired row returns null and deletes the row', async () => {
        const key = 'k-' + cuid();
        await db.setAccessState(key, { v: 1 }, past());
        assert.strictEqual(await db.getAccessState(key), null);
        // Subsequent get still null — row was eagerly removed.
        assert.strictEqual(await db.getAccessState(key), null);
      });

      it('[AS05] delete is idempotent on missing keys', async () => {
        await db.deleteAccessState('missing-' + cuid()); // must not throw
      });

      it('[AS06] delete removes the row', async () => {
        const key = 'k-' + cuid();
        await db.setAccessState(key, { v: 1 }, future());
        await db.deleteAccessState(key);
        assert.strictEqual(await db.getAccessState(key), null);
      });

      it('[AS07] sweepExpiredAccessStates removes only expired rows and reports count', async () => {
        const live1 = 'live1-' + cuid();
        const live2 = 'live2-' + cuid();
        const dead1 = 'dead1-' + cuid();
        const dead2 = 'dead2-' + cuid();
        await db.setAccessState(live1, { v: 1 }, future());
        await db.setAccessState(live2, { v: 2 }, future());
        await db.setAccessState(dead1, { v: 3 }, past());
        await db.setAccessState(dead2, { v: 4 }, past());
        const { removed } = await db.sweepExpiredAccessStates();
        assert.ok(removed >= 2, 'at least the two expired rows were removed (got ' + removed + ')');
        assert.ok((await db.getAccessState(live1)).value.v === 1);
        assert.ok((await db.getAccessState(live2)).value.v === 2);
        assert.strictEqual(await db.getAccessState(dead1), null);
        assert.strictEqual(await db.getAccessState(dead2), null);
      });

      it('[AS08] access-state namespace is isolated from dns-record / user-core / observability', async () => {
        const suffix = cuid();
        const stateKey = 'iso-' + suffix;
        await db.setAccessState(stateKey, { v: 1 }, future());
        await db.setDnsRecord('_iso-' + suffix, { txt: ['x'] });
        await db.setUserCore('iso-' + suffix, 'core-a');
        await db.setObservabilityValue('iso-' + suffix, 'obs-value');

        assert.deepStrictEqual((await db.getAccessState(stateKey)).value, { v: 1 });
        assert.ok(await db.getDnsRecord('_iso-' + suffix));
        assert.strictEqual(await db.getUserCore('iso-' + suffix), 'core-a');
        assert.strictEqual(await db.getObservabilityValue('iso-' + suffix), 'obs-value');
      });
    });
  });
};
