/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const chai = require('chai');
const assert = chai.assert;
const { getConfig } = require('@pryv/boiler');
const testServiceInfo = require('../../../../test/service-info.json');

describe('config: serviceInfo', () => {
  let config;
  let isOpenSource;
  before(async () => {
    config = await getConfig();
    isOpenSource = config.get('openSource:isActive');
  });
  describe('when dnsLess is disabled', () => {
    describe('when "serviceInfoUrl" points to a file', () => {
      it('[D2P7] should load serviceInfo', () => {
        const serviceInfo = config.get('service');
        if (!isOpenSource) {
          assert.deepEqual(serviceInfo, testServiceInfo);
        } else {
          assert.deepEqual(serviceInfo, {
            access: 'http://127.0.0.1:3000/reg/access/',
            api: 'http://127.0.0.1:3000/{username}/',
            serial: '2019061301',
            register: 'http://127.0.0.1:3000/reg/',
            name: 'Pryv Lab',
            home: 'https://sw.pryv.me',
            support: 'https://github.com/orgs/pryv/discussions',
            terms: 'https://pryv.com/terms-of-use/',
            eventTypes: 'https://pryv.github.io/event-types/flat.json',
            assets: {
              definitions: 'http://127.0.0.1:3000/www/assets/index.json'
            },
            features: {
              noHF: true
            }
          });
        }
      });
    });
  });
});
