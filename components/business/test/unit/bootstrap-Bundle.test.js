/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 34 Phase 2b — Bundle assembly + schema validation.
 */

const assert = require('node:assert/strict');
const Bundle = require('../../src/bootstrap/Bundle');

function validInput (overrides = {}) {
  const base = {
    cluster: {
      domain: 'mc.example.com',
      ackUrl: 'https://core-a.mc.example.com',
      joinToken: '0123456789abcdef0123456789abcdef',
      caCertPem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n'
    },
    node: {
      id: 'core-b',
      certPem: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----\n',
      keyPem: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAM...\n-----END PRIVATE KEY-----\n'
    },
    platformSecrets: {
      auth: {
        adminAccessKey: 'admin-key-0123456789abcdef0123',
        filesReadTokenSecret: 'files-secret-0123456789abcdef0'
      }
    }
  };
  return Object.assign({}, base, overrides);
}

describe('[BUNDLE] Bundle assembly & validation', () => {
  describe('assemble()', () => {
    it('produces a bundle with version 1 and a current issuedAt', () => {
      const before = Date.now();
      const b = Bundle.assemble(validInput());
      const after = Date.now();
      assert.equal(b.version, 1);
      const issued = Date.parse(b.issuedAt);
      assert(issued >= before && issued <= after, `issuedAt=${b.issuedAt}`);
    });

    it('copies cluster / node / platformSecrets verbatim', () => {
      const input = validInput();
      const b = Bundle.assemble(input);
      assert.equal(b.cluster.domain, input.cluster.domain);
      assert.equal(b.cluster.ackUrl, input.cluster.ackUrl);
      assert.equal(b.cluster.joinToken, input.cluster.joinToken);
      assert.equal(b.cluster.ca.certPem, input.cluster.caCertPem);
      assert.equal(b.node.id, input.node.id);
      assert.equal(b.node.certPem, input.node.certPem);
      assert.equal(b.node.keyPem, input.node.keyPem);
      assert.deepEqual(b.platformSecrets.auth, input.platformSecrets.auth);
    });

    it('defaults optional node fields to null', () => {
      const b = Bundle.assemble(validInput());
      assert.equal(b.node.ip, null);
      assert.equal(b.node.hosting, null);
      assert.equal(b.node.url, null);
    });

    it('preserves node.ip / hosting / url when provided', () => {
      const input = validInput();
      input.node.ip = '1.2.3.4';
      input.node.hosting = 'us-east-1';
      input.node.url = 'https://api.example.com';
      const b = Bundle.assemble(input);
      assert.equal(b.node.ip, '1.2.3.4');
      assert.equal(b.node.hosting, 'us-east-1');
      assert.equal(b.node.url, 'https://api.example.com');
    });

    it('defaults rqlite ports to 4001/4002', () => {
      const b = Bundle.assemble(validInput());
      assert.equal(b.rqlite.raftPort, 4002);
      assert.equal(b.rqlite.httpPort, 4001);
    });

    it('respects custom rqlite ports', () => {
      const input = validInput();
      input.rqlite = { raftPort: 9002, httpPort: 9001 };
      const b = Bundle.assemble(input);
      assert.equal(b.rqlite.raftPort, 9002);
      assert.equal(b.rqlite.httpPort, 9001);
    });

    for (const k of ['cluster', 'node', 'platformSecrets']) {
      it(`throws when ${k} is missing`, () => {
        const input = validInput();
        delete input[k];
        assert.throws(() => Bundle.assemble(input), new RegExp(`input.${k}`));
      });
    }

    for (const k of ['domain', 'ackUrl', 'joinToken', 'caCertPem']) {
      it(`throws when cluster.${k} is missing`, () => {
        const input = validInput();
        delete input.cluster[k];
        assert.throws(() => Bundle.assemble(input), new RegExp(`cluster.${k}`));
      });
    }

    for (const k of ['id', 'certPem', 'keyPem']) {
      it(`throws when node.${k} is missing`, () => {
        const input = validInput();
        delete input.node[k];
        assert.throws(() => Bundle.assemble(input), new RegExp(`node.${k}`));
      });
    }

    for (const k of ['adminAccessKey', 'filesReadTokenSecret']) {
      it(`throws when platformSecrets.auth.${k} is missing`, () => {
        const input = validInput();
        delete input.platformSecrets.auth[k];
        assert.throws(() => Bundle.assemble(input), new RegExp(`auth.${k}`));
      });
    }
  });

  describe('validate()', () => {
    it('accepts a freshly assembled bundle', () => {
      const b = Bundle.assemble(validInput());
      assert.equal(Bundle.validate(b), b);
    });

    it('rejects a non-object', () => {
      assert.throws(() => Bundle.validate(null), /not an object/);
      assert.throws(() => Bundle.validate('hi'), /not an object/);
    });

    it('rejects unknown version', () => {
      const b = Bundle.assemble(validInput());
      b.version = 99;
      assert.throws(() => Bundle.validate(b), /unsupported version 99/);
    });

    it('rejects missing top-level key', () => {
      const b = Bundle.assemble(validInput());
      delete b.cluster;
      assert.throws(() => Bundle.validate(b), /cluster/);
    });

    it('rejects non-PEM ca.certPem', () => {
      const b = Bundle.assemble(validInput());
      b.cluster.ca.certPem = 'not a cert';
      assert.throws(() => Bundle.validate(b), /ca\.certPem must be a PEM certificate/);
    });

    it('rejects trivially short joinToken', () => {
      const b = Bundle.assemble(validInput());
      b.cluster.joinToken = 'short';
      assert.throws(() => Bundle.validate(b), /joinToken/);
    });

    it('rejects non-PEM node.certPem / keyPem', () => {
      const b = Bundle.assemble(validInput());
      b.node.certPem = 'not a cert';
      assert.throws(() => Bundle.validate(b), /node\.certPem/);
      const b2 = Bundle.assemble(validInput());
      b2.node.keyPem = 'not a key';
      assert.throws(() => Bundle.validate(b2), /node\.keyPem/);
    });

    it('rejects missing platform secret', () => {
      const b = Bundle.assemble(validInput());
      delete b.platformSecrets.auth.adminAccessKey;
      assert.throws(() => Bundle.validate(b), /adminAccessKey/);
    });

    it('rejects missing rqlite port', () => {
      const b = Bundle.assemble(validInput());
      delete b.rqlite.raftPort;
      assert.throws(() => Bundle.validate(b), /raftPort/);
    });
  });
});
