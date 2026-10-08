/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;

const Service = require('../../../src/mfa/Service.ts').default;

// Placeholder substitution and encoding are covered by smsRequest.test.js.
describe('[MFAS] mfa/Service', () => {
  describe('[MFAB] base class', () => {
    it('[MS3A] challenge() and verify() throw on the abstract base', async () => {
      const svc = new Service({ mode: 'disabled' });
      try {
        await svc.challenge('u', null, null);
        assert.fail('expected throw');
      } catch (e) {
        assert.match(e.message, /override challenge/);
      }
      try {
        await svc.verify('u', null, null);
        assert.fail('expected throw');
      } catch (e) {
        assert.match(e.message, /override verify/);
      }
    });
  });
});
