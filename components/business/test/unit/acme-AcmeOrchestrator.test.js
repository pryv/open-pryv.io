/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 35 Phase 4b — AcmeOrchestrator.
 *
 * Uses a fake CertRenewer + fake FileMaterializer to test the interval /
 * renew-decision logic without touching ACME, PlatformDB or the fs.
 * The building blocks are covered by their own test files.
 */

const assert = require('node:assert/strict');

const { AcmeOrchestrator } = require('../../src/acme/AcmeOrchestrator');

function makeFakeRenewer () {
  const calls = [];
  let stored = null;
  return {
    _calls: calls,
    _setStored (c) { stored = c; },
    async getCertificate () { return stored; },
    async renew (opts) {
      calls.push(opts);
      const result = {
        hostname: opts.hostname,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 90 * 24 * 3600 * 1000
      };
      stored = { ...result, certPem: 'LEAF', chainPem: '', keyPem: 'K' };
      return result;
    }
  };
}
function makeFakeFm () {
  const calls = [];
  return {
    _calls: calls,
    async checkOnce () { calls.push(Date.now()); return { rotated: false, reason: 'unchanged' }; }
  };
}
const dummyDnsWriter = { async create () {}, async remove () {} };

describe('[ACMEORCH] AcmeOrchestrator', function () {
  this.timeout(5000);

  describe('constructor validation', () => {
    it('rejects missing required deps', () => {
      const ok = {
        hostSpec: { commonName: 'h', altNames: [], challenge: 'dns-01' },
        certRenewer: makeFakeRenewer(),
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter
      };
      assert.throws(() => new AcmeOrchestrator({ ...ok, hostSpec: null }), /hostSpec/);
      assert.throws(() => new AcmeOrchestrator({ ...ok, certRenewer: null }), /certRenewer/);
      assert.throws(() => new AcmeOrchestrator({ ...ok, fileMaterializer: null }), /fileMaterializer/);
      assert.throws(() => new AcmeOrchestrator({ ...ok, dnsWriter: null }), /dnsWriter/);
    });
  });

  describe('triggerRenewCheck()', () => {
    const hostSpec = { commonName: '*.ex.com', altNames: ['ex.com'], challenge: 'dns-01' };

    it('no-ops when isRenewer=false', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: false,
        log: () => {}
      });
      const r = await orch.triggerRenewCheck();
      assert.deepEqual(r, { skipped: true, reason: 'not-renewer' });
      assert.equal(renewer._calls.length, 0);
    });

    it('issues initial cert when none stored', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        log: () => {}
      });
      const r = await orch.triggerRenewCheck();
      assert.equal(r.renewed, true);
      assert.equal(r.hostname, '*.ex.com');
      assert.equal(renewer._calls.length, 1);
      assert.deepEqual(renewer._calls[0].altNames, ['ex.com']);
      assert.deepEqual(renewer._calls[0].challengePriority, ['dns-01']);
    });

    it('renews when stored cert is within renewBeforeDays', async () => {
      const renewer = makeFakeRenewer();
      // Cert expiring in 10 days; renewBeforeDays=30 → renew.
      renewer._setStored({ expiresAt: Date.now() + 10 * 24 * 3600 * 1000 });
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        renewBeforeDays: 30,
        log: () => {}
      });
      const r = await orch.triggerRenewCheck();
      assert.equal(r.renewed, true);
    });

    it('skips when stored cert expires well after renewBeforeDays', async () => {
      const renewer = makeFakeRenewer();
      // Cert expiring in 60 days; renewBeforeDays=30 → skip.
      renewer._setStored({ expiresAt: Date.now() + 60 * 24 * 3600 * 1000 });
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        renewBeforeDays: 30,
        log: () => {}
      });
      const r = await orch.triggerRenewCheck();
      assert.equal(r.skipped, true);
      assert.equal(r.reason, 'not-yet-due');
      assert.equal(r.daysLeft, 60);
      assert.equal(renewer._calls.length, 0);
    });

    it('uses http-01 priority when hostSpec says so', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec: { commonName: 'h.test', altNames: [], challenge: 'http-01' },
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        log: () => {}
      });
      await orch.triggerRenewCheck();
      assert.deepEqual(renewer._calls[0].challengePriority, ['http-01']);
    });
  });

  describe('forceRenew()', () => {
    const hostSpec = { commonName: '*.ex.com', altNames: ['ex.com'], challenge: 'dns-01' };

    it('throws on a non-renewer core', async () => {
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: makeFakeRenewer(),
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: false,
        log: () => {}
      });
      await assert.rejects(orch.forceRenew(), /not the certRenewer core/);
      assert.equal(orch.isRenewer, false);
    });

    it('issues even when stored cert is well outside renewBeforeDays', async () => {
      const renewer = makeFakeRenewer();
      // Stored cert valid for 60 days — triggerRenewCheck would skip it,
      // but forceRenew must issue anyway.
      renewer._setStored({ expiresAt: Date.now() + 60 * 24 * 3600 * 1000 });
      const fm = makeFakeFm();
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: fm,
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        renewBeforeDays: 30,
        log: () => {}
      });
      const result = await orch.forceRenew();
      assert.equal(result.renewed, true);
      assert.equal(result.hostname, '*.ex.com');
      assert.equal(renewer._calls.length, 1);
      // Materialize was triggered after issue (so the new cert lands on
      // disk on this core right away).
      assert.equal(fm._calls.length, 1);
    });

    it('uses primary hostSpec defaults when hostname omitted', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        log: () => {}
      });
      await orch.forceRenew();
      assert.equal(renewer._calls[0].hostname, '*.ex.com');
      assert.deepEqual(renewer._calls[0].altNames, ['ex.com']);
      assert.deepEqual(renewer._calls[0].challengePriority, ['dns-01']);
    });

    it('passes through an explicit non-primary hostname (no altNames carry-over)', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec,
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        log: () => {}
      });
      await orch.forceRenew('other.example.com');
      assert.equal(renewer._calls[0].hostname, 'other.example.com');
      assert.deepEqual(renewer._calls[0].altNames, []);
      assert.equal(renewer._calls[0].challengePriority, undefined);
    });
  });

  describe('start() / stop()', () => {
    it('immediately triggers one materialize tick on start', async () => {
      const fm = makeFakeFm();
      const orch = new AcmeOrchestrator({
        hostSpec: { commonName: 'h.test', altNames: [], challenge: 'http-01' },
        certRenewer: makeFakeRenewer(),
        fileMaterializer: fm,
        dnsWriter: dummyDnsWriter,
        isRenewer: false,
        materializeIntervalMs: 100_000,
        renewIntervalMs: 100_000,
        log: () => {}
      });
      orch.start();
      // Immediate prime — let microtasks run
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fm._calls.length, 1);
      orch.stop();
    });

    it('immediately triggers one renew check on start when isRenewer=true', async () => {
      const renewer = makeFakeRenewer();
      const orch = new AcmeOrchestrator({
        hostSpec: { commonName: 'h.test', altNames: [], challenge: 'http-01' },
        certRenewer: renewer,
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        materializeIntervalMs: 100_000,
        renewIntervalMs: 100_000,
        log: () => {}
      });
      orch.start();
      // Let both initial async paths resolve (materialize + renew)
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(renewer._calls.length, 1);
      orch.stop();
    });

    it('throws on double start', () => {
      const orch = new AcmeOrchestrator({
        hostSpec: { commonName: 'h.test', altNames: [], challenge: 'http-01' },
        certRenewer: makeFakeRenewer(),
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: false,
        materializeIntervalMs: 100_000,
        log: () => {}
      });
      orch.start();
      assert.throws(() => orch.start(), /already running/);
      orch.stop();
    });

    it('stop() is idempotent and clears timers', () => {
      const orch = new AcmeOrchestrator({
        hostSpec: { commonName: 'h.test', altNames: [], challenge: 'http-01' },
        certRenewer: makeFakeRenewer(),
        fileMaterializer: makeFakeFm(),
        dnsWriter: dummyDnsWriter,
        isRenewer: true,
        materializeIntervalMs: 100_000,
        renewIntervalMs: 100_000,
        log: () => {}
      });
      orch.start();
      orch.stop();
      orch.stop(); // second call is a no-op
    });
  });
});
