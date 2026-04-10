/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;

const Service = require('../../../src/mfa/Service');

describe('[MFAS] mfa/Service', () => {
  describe('[MFAR] replaceAll', () => {
    it('[MS1A] replaces every {{ key }} occurrence in a string', () => {
      const out = Service.replaceAll('hello {{ name }}, your code is {{ code }}, {{ name }}', 'name', 'Alice');
      assert.equal(out, 'hello Alice, your code is {{ code }}, Alice');
    });

    it('[MS1B] returns non-strings unchanged', () => {
      assert.equal(Service.replaceAll(42, 'name', 'Alice'), 42);
      assert.deepEqual(Service.replaceAll({ a: 1 }, 'name', 'Alice'), { a: 1 });
    });
  });

  describe('[MFAC] replaceRecursively', () => {
    it('[MS2A] walks an object tree replacing string leaves', () => {
      const input = {
        a: 'hello {{ name }}',
        b: { c: 'code: {{ code }}', d: 1 },
        e: 2,
        f: ['list {{ name }}', 'plain']
      };
      const out = Service.replaceRecursively(input, 'name', 'Alice');
      assert.equal(out.a, 'hello Alice');
      assert.equal(out.b.c, 'code: {{ code }}');
      assert.equal(out.b.d, 1);
      assert.equal(out.e, 2);
      assert.deepEqual(out.f, ['list Alice', 'plain']);
    });

    it('[MS2B] does not mutate the input', () => {
      const input = { a: 'hello {{ name }}' };
      Service.replaceRecursively(input, 'name', 'Alice');
      assert.equal(input.a, 'hello {{ name }}');
    });

    it('[MS2C] passes null/undefined through', () => {
      assert.isNull(Service.replaceRecursively(null, 'name', 'Alice'));
      assert.isUndefined(Service.replaceRecursively(undefined, 'name', 'Alice'));
    });
  });

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
