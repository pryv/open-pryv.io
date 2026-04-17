/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for rqliteProcess.buildArgs() — the pure function that builds
 * the argv passed to rqlited. Covers Plan 34 Phase 1 (rqlite TLS flag passthrough)
 * and the pre-existing argv (single-core + DNS discovery).
 *
 * These tests do NOT spawn rqlited and do not require network / filesystem state.
 */

const assert = require('node:assert/strict');
const { buildArgs } = require('../src/rqliteProcess');

describe('[RQARGS] rqliteProcess.buildArgs', () => {
  const baseOpts = {
    coreId: 'core-a',
    dataDir: '/var/pryv/rqlite-data',
    httpPort: 4001,
    raftPort: 4002
  };

  describe('baseline (no TLS, no DNS discovery)', () => {
    it('includes node-id, http-addr, raft-addr and the data dir at the end', () => {
      const args = buildArgs(baseOpts);
      assert.deepEqual(args, [
        '-node-id', 'core-a',
        '-http-addr', '0.0.0.0:4001',
        '-http-adv-addr', '127.0.0.1:4001',
        '-raft-addr', '127.0.0.1:4002',
        '-raft-cluster-remove-shutdown',
        '/var/pryv/rqlite-data'
      ]);
    });

    it('binds 0.0.0.0 and advertises coreIp separately in multi-core (NAT-aware)', () => {
      const args = buildArgs({ ...baseOpts, coreIp: '10.0.0.5' });
      assert(args.includes('-http-adv-addr'));
      assert.equal(args[args.indexOf('-http-adv-addr') + 1], '10.0.0.5:4001');
      // Raft listens on all interfaces; advertises the public IP to peers.
      // Binding the public IP directly fails on NAT'd clouds (EC2) where
      // the network interface only holds the private IP.
      assert.equal(args[args.indexOf('-raft-addr') + 1], '0.0.0.0:4002');
      assert(args.includes('-raft-adv-addr'));
      assert.equal(args[args.indexOf('-raft-adv-addr') + 1], '10.0.0.5:4002');
    });

    it('single-core (no coreIp) stays on loopback without -raft-adv-addr', () => {
      const args = buildArgs({ ...baseOpts });
      assert.equal(args[args.indexOf('-raft-addr') + 1], '127.0.0.1:4002');
      assert(!args.includes('-raft-adv-addr'));
    });

    it('does not add any TLS flag when tls option is null', () => {
      const args = buildArgs({ ...baseOpts, tls: null });
      const tlsFlags = ['-node-ca-cert', '-node-cert', '-node-key', '-node-verify-client', '-node-verify-server-name'];
      for (const flag of tlsFlags) assert(!args.includes(flag), `unexpected ${flag} in ${args.join(' ')}`);
    });
  });

  describe('DNS discovery (multi-core)', () => {
    it('adds -disco-mode dns and -disco-config lsc.{domain} when dnsDomain is set', () => {
      const args = buildArgs({ ...baseOpts, dnsDomain: 'mc.example.com' });
      assert(args.includes('-disco-mode'));
      assert.equal(args[args.indexOf('-disco-mode') + 1], 'dns');
      const discoConfig = JSON.parse(args[args.indexOf('-disco-config') + 1]);
      assert.equal(discoConfig.name, 'lsc.mc.example.com');
      assert.equal(discoConfig.port, 4002);
    });
  });

  describe('TLS (Plan 34 Phase 1)', () => {
    const tls = {
      caFile: '/etc/pryv/tls/ca.crt',
      certFile: '/etc/pryv/tls/node.crt',
      keyFile: '/etc/pryv/tls/node.key'
    };

    it('adds -node-ca-cert, -node-cert and -node-key when tls is set', () => {
      const args = buildArgs({ ...baseOpts, tls });
      assert.equal(args[args.indexOf('-node-ca-cert') + 1], '/etc/pryv/tls/ca.crt');
      assert.equal(args[args.indexOf('-node-cert') + 1], '/etc/pryv/tls/node.crt');
      assert.equal(args[args.indexOf('-node-key') + 1], '/etc/pryv/tls/node.key');
    });

    it('adds -node-verify-client by default (mTLS is the point)', () => {
      const args = buildArgs({ ...baseOpts, tls });
      assert(args.includes('-node-verify-client'));
    });

    it('omits -node-verify-client when verifyClient: false', () => {
      const args = buildArgs({ ...baseOpts, tls: { ...tls, verifyClient: false } });
      assert(!args.includes('-node-verify-client'));
    });

    it('adds -node-verify-server-name when verifyServerName is set', () => {
      const args = buildArgs({ ...baseOpts, tls: { ...tls, verifyServerName: 'pryv-cluster' } });
      const idx = args.indexOf('-node-verify-server-name');
      assert(idx > -1);
      assert.equal(args[idx + 1], 'pryv-cluster');
    });

    it('omits -node-verify-server-name when not set (rqlite default applies)', () => {
      const args = buildArgs({ ...baseOpts, tls });
      assert(!args.includes('-node-verify-server-name'));
    });

    it('throws when tls is set but caFile is missing', () => {
      assert.throws(
        () => buildArgs({ ...baseOpts, tls: { certFile: tls.certFile, keyFile: tls.keyFile } }),
        /caFile.*certFile.*keyFile/i
      );
    });

    it('throws when tls is set but certFile is missing', () => {
      assert.throws(
        () => buildArgs({ ...baseOpts, tls: { caFile: tls.caFile, keyFile: tls.keyFile } }),
        /caFile.*certFile.*keyFile/i
      );
    });

    it('throws when tls is set but keyFile is missing', () => {
      assert.throws(
        () => buildArgs({ ...baseOpts, tls: { caFile: tls.caFile, certFile: tls.certFile } }),
        /caFile.*certFile.*keyFile/i
      );
    });

    it('puts the data dir after all TLS flags (must stay last)', () => {
      const args = buildArgs({ ...baseOpts, tls });
      assert.equal(args[args.length - 1], '/var/pryv/rqlite-data');
    });
  });

  describe('combined: multi-core + mTLS', () => {
    it('includes both DNS discovery flags and TLS flags', () => {
      const args = buildArgs({
        ...baseOpts,
        coreIp: '10.0.0.5',
        dnsDomain: 'mc.example.com',
        tls: {
          caFile: '/tls/ca.crt',
          certFile: '/tls/node.crt',
          keyFile: '/tls/node.key'
        }
      });
      assert(args.includes('-disco-mode'));
      assert(args.includes('-node-ca-cert'));
      assert(args.includes('-node-verify-client'));
      assert.equal(args[args.indexOf('-raft-addr') + 1], '0.0.0.0:4002');
      assert.equal(args[args.indexOf('-raft-adv-addr') + 1], '10.0.0.5:4002');
      assert.equal(args[args.indexOf('-bootstrap-expect') + 1], '1');
      assert.equal(args[args.length - 1], '/var/pryv/rqlite-data');
    });
  });
});
