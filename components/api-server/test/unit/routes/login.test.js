/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

require('test-helpers/src/api-server-tests-config');
const assert = require('node:assert');
const express = require('express');
const authMod = require('api-server/src/routes/auth/login');

describe('[AUTN] Authentication', function () {
  const settings = {
    auth: {
      sessionMaxAge: 3600 * 1000
    },
    http: {
      ip: '127.0.0.1'
    },
    deprecated: {
      auth: {}
    },
    get: () => {
      return {
        str: () => {
          return '';
        },
        num: () => {
          return 0;
        },
        bool: () => {
          return false;
        }
      };
    },
    has: () => {
      return true;
    },
    getCustomAuthFunction: () => { }
  };
  describe('[AT01] hasProperties', function () {
    // FLOW Mock out the settings object for this unit test
    const { hasProperties } = authMod(express(), { settings });
    const obj = { a: 1, b: 2 };
    const keys = ['a', 'b'];

    it('[IKAI] returns true if all properties exist', function () {
      assert.strictEqual(hasProperties(obj, keys), true);
    });
    it('[K2PZ] returns false if not all properties exist', function () {
      assert.strictEqual(hasProperties(obj, ['a', 'c']), false);
    });
    it('[U2NA] returns false if null is given', function () {
      assert.strictEqual(hasProperties(null, ['a', 'c']), false);
    });
    it('[WJ7J] returns false if a string is given', function () {
      assert.strictEqual(hasProperties('a string', ['a', 'c']), false);
    });
  });
});
