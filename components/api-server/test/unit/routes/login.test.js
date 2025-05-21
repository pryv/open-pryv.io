/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

'use strict';

const should = require('should');
const express = require('express');
const authMod = require('api-server/src/routes/auth/login');

describe('Authentication', function () {
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
  describe('hasProperties', function () {
    // FLOW Mock out the settings object for this unit test
    const { hasProperties } = authMod(express(), { settings });
    const obj = { a: 1, b: 2 };
    const keys = ['a', 'b'];

    it('[IKAI] returns true if all properties exist', function () {
      should(
        hasProperties(obj, keys)
      ).be.ok();
    });
    it('[K2PZ] returns false if not all properties exist', function () {
      should(
        hasProperties(obj, ['a', 'c'])
      ).be.false();
    });
    it('[U2NA] returns false if null is given', function () {
      should(
        hasProperties(null, ['a', 'c'])
      ).be.false();
    });
    it('[WJ7J] returns false if a string is given', function () {
      should(
        hasProperties('a string', ['a', 'c'])
      ).be.false();
    });
  });
});
