/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 2d — DnsRegistration.
 *
 * Uses a minimal in-memory fake implementing the PlatformDB methods this
 * module depends on. No rqlite or MongoDB required.
 */

const assert = require('node:assert/strict');
const DnsRegistration = require('../../src/bootstrap/DnsRegistration');

/**
 * Minimal fake PlatformDB, just the methods DnsRegistration touches.
 * Records every call for assertions.
 */
function makeFakeDB ({ supportsDeleteCoreInfo = true } = {}) {
  const coreInfos = new Map();
  const dns = new Map();
  const calls = [];

  const db = {
    async setCoreInfo (id, info) { calls.push(['setCoreInfo', id, info]); coreInfos.set(id, info); },
    async getCoreInfo (id) { calls.push(['getCoreInfo', id]); return coreInfos.get(id) ?? null; },
    async setDnsRecord (sub, records) { calls.push(['setDnsRecord', sub, records]); dns.set(sub, records); },
    async getDnsRecord (sub) { calls.push(['getDnsRecord', sub]); return dns.get(sub) ?? null; },
    async deleteDnsRecord (sub) { calls.push(['deleteDnsRecord', sub]); dns.delete(sub); }
  };
  if (supportsDeleteCoreInfo) {
    db.deleteCoreInfo = async (id) => { calls.push(['deleteCoreInfo', id]); coreInfos.delete(id); };
  }

  return { db, coreInfos, dns, calls };
}

describe('[DNSREG] DnsRegistration', () => {
  describe('registerNewCore()', () => {
    it('writes coreInfo with available:false and the passed metadata', async () => {
      const { db, coreInfos } = makeFakeDB();
      await DnsRegistration.registerNewCore({
        platformDB: db, coreId: 'core-b', ip: '1.2.3.4', url: 'https://b.ex.com', hosting: 'us-east-1'
      });
      const info = coreInfos.get('core-b');
      assert.deepEqual(info, {
        id: 'core-b',
        ip: '1.2.3.4',
        url: 'https://b.ex.com',
        hosting: 'us-east-1',
        available: false
      });
    });

    it('defaults url and hosting to null when not provided', async () => {
      const { db, coreInfos } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '1.2.3.4' });
      const info = coreInfos.get('core-b');
      assert.equal(info.url, null);
      assert.equal(info.hosting, null);
    });

    it('writes the per-core A record', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '1.2.3.4' });
      assert.deepEqual(dns.get('core-b'), { a: ['1.2.3.4'] });
    });

    it('is a no-op on the per-core A record when the same value is already present', async () => {
      const { db, calls } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '1.2.3.4' });
      const setCallsFirst = calls.filter(c => c[0] === 'setDnsRecord' && c[1] === 'core-b').length;
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '1.2.3.4' });
      const setCallsSecond = calls.filter(c => c[0] === 'setDnsRecord' && c[1] === 'core-b').length;
      assert.equal(setCallsFirst, 1);
      assert.equal(setCallsSecond, 1, 'second call should not rewrite the same record');
    });

    it('creates lsc A record on first call', async () => {
      const { db, dns } = makeFakeDB();
      const res = await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      assert.deepEqual(dns.get('lsc'), { a: ['1.1.1.1'] });
      assert.deepEqual(res.lscIpsAfter, ['1.1.1.1']);
    });

    it('appends to an existing lsc record', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      const res = await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.deepEqual(dns.get('lsc').a, ['1.1.1.1', '2.2.2.2']);
      assert.deepEqual(res.lscIpsAfter, ['1.1.1.1', '2.2.2.2']);
    });

    it('does not duplicate an IP already in lsc', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      assert.deepEqual(dns.get('lsc').a, ['1.1.1.1']);
    });

    it('preserves other record types on lsc', async () => {
      const { db, dns } = makeFakeDB();
      // Pre-seed lsc with an unrelated TXT record (say from ACME)
      await db.setDnsRecord('lsc', { a: ['1.1.1.1'], txt: ['acme-challenge-xyz'] });
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      const lsc = dns.get('lsc');
      assert.deepEqual(lsc.a, ['1.1.1.1', '2.2.2.2']);
      assert.deepEqual(lsc.txt, ['acme-challenge-xyz']);
    });

    it('requires platformDB, coreId, ip', async () => {
      const { db } = makeFakeDB();
      await assert.rejects(() => DnsRegistration.registerNewCore({ coreId: 'c', ip: '1.2.3.4' }), /platformDB/);
      await assert.rejects(() => DnsRegistration.registerNewCore({ platformDB: db, ip: '1.2.3.4' }), /coreId/);
      await assert.rejects(() => DnsRegistration.registerNewCore({ platformDB: db, coreId: 'c' }), /ip/);
    });
  });

  describe('unregisterNewCore()', () => {
    it('removes the coreInfo when core is still available:false', async () => {
      const { db, coreInfos } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.equal(coreInfos.has('core-b'), false);
    });

    it('does not remove coreInfo that is already available:true', async () => {
      const { db, coreInfos } = makeFakeDB();
      await db.setCoreInfo('core-b', { id: 'core-b', ip: '2.2.2.2', available: true });
      const res = await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.equal(res.coreInfoDeleted, false);
      assert(coreInfos.has('core-b'), 'coreInfo must remain for an already-active core');
    });

    it('falls back to setCoreInfo when deleteCoreInfo is not available', async () => {
      const { db, coreInfos } = makeFakeDB({ supportsDeleteCoreInfo: false });
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      const res = await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.equal(res.coreInfoDeleted, true);
      assert(coreInfos.has('core-b'), 'fallback leaves the row in place');
      assert.equal(coreInfos.get('core-b').available, false);
    });

    it('drops the per-core A record when it still points at our ip', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert(!dns.has('core-b'));
    });

    it('does not drop the per-core A record when it points at a different ip', async () => {
      const { db, dns } = makeFakeDB();
      // Pre-seed with a conflicting value
      await db.setDnsRecord('core-b', { a: ['9.9.9.9'] });
      const res = await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.equal(res.perCoreDeleted, false);
      assert.deepEqual(dns.get('core-b'), { a: ['9.9.9.9'] });
    });

    it('removes only our ip from lsc, leaving others', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.deepEqual(dns.get('lsc').a, ['1.1.1.1']);
    });

    it('deletes lsc entirely when it becomes empty', async () => {
      const { db, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-a', ip: '1.1.1.1' });
      assert(!dns.has('lsc'));
    });

    it('is a no-op when nothing was ever registered', async () => {
      const { db, calls } = makeFakeDB();
      const res = await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.equal(res.coreInfoDeleted, false);
      assert.equal(res.perCoreDeleted, false);
      assert.deepEqual(res.lscIpsAfter, []);
      // Should have read but not written anything
      assert(!calls.some(c => c[0] === 'setCoreInfo' || c[0] === 'setDnsRecord' || c[0] === 'deleteCoreInfo'));
    });

    it('requires platformDB, coreId, ip', async () => {
      const { db } = makeFakeDB();
      await assert.rejects(() => DnsRegistration.unregisterNewCore({ coreId: 'c', ip: '1.2.3.4' }), /platformDB/);
      await assert.rejects(() => DnsRegistration.unregisterNewCore({ platformDB: db, ip: '1.2.3.4' }), /coreId/);
      await assert.rejects(() => DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'c' }), /ip/);
    });
  });

  describe('register → unregister → register round-trip', () => {
    it('leaves PlatformDB in the same state as fresh register', async () => {
      const { db, coreInfos, dns } = makeFakeDB();
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      await DnsRegistration.unregisterNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      await DnsRegistration.registerNewCore({ platformDB: db, coreId: 'core-b', ip: '2.2.2.2' });
      assert.deepEqual(coreInfos.get('core-b'), {
        id: 'core-b', ip: '2.2.2.2', url: null, hosting: null, available: false
      });
      assert.deepEqual(dns.get('core-b'), { a: ['2.2.2.2'] });
      assert.deepEqual(dns.get('lsc').a, ['2.2.2.2']);
    });
  });
});
