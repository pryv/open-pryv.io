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
const nock = require('nock');
const mailing = require('../../../src/methods/helpers/mailing');

describe('Mailing helper methods', () => {
  const template = 'welcome';
  const recipient = {
    name: 'bob',
    email: 'bobo@test.com',
    type: 'to'
  };
  const lang = 'en';
  const substitutions = {
    name: recipient.name,
    email: recipient.email
  };

  it('[HGVD] should throw an error if mailing method is invalid', () => {
    const emailSettings = {
      method: 'invalid',
      url: 'https://127.0.0.1:9000/sendmail',
      key: 'v3ryStrongK3y'
    };

    mailing.sendmail(emailSettings, template, recipient, substitutions, lang, (err) => {
      assert.isNotNull(err);
    });
  });

  it('[OKQ2] should throw an error if mailing method is missing', () => {
    const emailSettings = {
      url: 'https://127.0.0.1:9000/sendmail',
      key: 'v3ryStrongK3y'
    };

    mailing.sendmail(emailSettings, template, recipient, substitutions, lang, (err) => {
      assert.isNotNull(err);
    });
  });

  describe('using Mandrill', () => {
    const baseURL = 'https://mandrillapp.local';
    const path = '/messages/send';
    const emailSettings = {
      method: 'mandrill',
      url: baseURL + path,
      key: 'v3ryStrongK3y'
    };

    describe('validating request body', () => {
      let requestBody;
      before((done) => {
        nock(baseURL)
          .post(path)
          .reply(200, (uri, req) => {
            requestBody = req;
          });
        mailing.sendmail(emailSettings, template, recipient, substitutions, lang, done);
      });

      it('[GU60] should not be empty', () => {
        assert.isNotNull(requestBody);
      });

      it('[8JJU] should contain a valid auth key', () => {
        assert.strictEqual(requestBody.key, emailSettings.key);
      });

      it('[G906] should contain a valid recipient', () => {
        assert.deepEqual(requestBody.message.to, [recipient]);
      });

      it('[KBE0] should contain a valid substitution of variables', () => {
        assert.deepEqual(requestBody.message.global_merge_vars, [
          { name: 'name', content: recipient.name },
          { name: 'email', content: recipient.email }
        ]);
      });

      it('[2ABY] should contain valid tags', () => {
        assert.deepEqual(requestBody.message.tags, [template]);
      });
    });
  });

  describe('using Microservice', () => {
    const baseURL = 'https://127.0.0.1:9000/sendmail/';
    const path = '/' + template + '/' + lang;
    const emailSettings = {
      method: 'microservice',
      url: baseURL,
      key: 'v3ryStrongK3y'
    };

    describe('validating request body', () => {
      let requestBody;
      before((done) => {
        nock(baseURL)
          .post(path)
          .reply(200, (uri, req) => {
            requestBody = req;
          });
        mailing.sendmail(emailSettings, template, recipient, substitutions, lang, done);
      });

      it('[LHCB] should not be empty', () => {
        assert.isNotNull(requestBody);
      });

      it('[9UEU] should contain a valid auth key', () => {
        assert.strictEqual(requestBody.key, emailSettings.key);
      });

      it('[1Y6K] should contain a valid recipient', () => {
        assert.strictEqual(requestBody.to.name, recipient.name);
        assert.strictEqual(requestBody.to.email, recipient.email);
      });

      it('[UT8M] should contain a valid substitution of variables', () => {
        assert.deepEqual(requestBody.substitutions, substitutions);
      });
    });
  });
});
