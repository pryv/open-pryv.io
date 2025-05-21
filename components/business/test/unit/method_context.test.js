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

require('test-helpers/src/api-server-tests-config');
const timestamp = require('unix-timestamp');
const sinon = require('sinon');
const chai = require('chai');
const assert = chai.assert;
const MethodContext = require('../../src/MethodContext');

const contextSource = {
  name: 'test',
  ip: '127.0.0.1'
};

describe('MethodContext', () => {
  describe('#parseAuth', () => {
    const username = 'USERNAME';
    const customAuthStep = null;
    it('[ZRW8] should parse token out', () => {
      const mc = new MethodContext(contextSource, username, 'TOKEN', customAuthStep);
      assert.strictEqual(mc.accessToken, 'TOKEN');
      assert.isNull(mc.callerId);
    });
    it('[AUIY] should also parse the callerId when available', () => {
      const mc = new MethodContext(contextSource, username, 'TOKEN CALLERID', customAuthStep);
      assert.strictEqual(mc.accessToken, 'TOKEN');
      assert.strictEqual(mc.callerId, 'CALLERID');
    });
  });

  describe('#retrieveAccessFromId', () => {
    const username = 'USERNAME';
    const customAuthStep = null;
    let access;
    let mc, findOne, storage;
    beforeEach(() => {
      mc = new MethodContext(contextSource, username, 'TOKEN CALLERID', customAuthStep);
      access = {
        id: 'accessIdFromAccess',
        token: 'tokenFromAccess'
      };
      findOne = sinon.fake.yields(null, access);
      storage = {
        accesses: {
          findOne
        }
      };
    });
    it('[OJW2] checks expiry of the access', async () => {
      access.expires = timestamp.now('-1d');
      let caught = false;
      try {
        // storage is a fake
        await mc.retrieveAccessFromId(storage, 'accessId');
      } catch (err) {
        caught = true;
      }
      assert.isTrue(caught);
    });
  });
});
