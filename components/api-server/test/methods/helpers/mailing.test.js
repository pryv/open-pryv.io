/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const assert = require('node:assert');
const nock = require('nock');
const mailing = require('../../../src/methods/helpers/mailing');

describe('[MAIL] Mailing helper methods', () => {
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
      assert.ok(err != null);
    });
  });

  it('[OKQ2] should throw an error if mailing method is missing', () => {
    const emailSettings = {
      url: 'https://127.0.0.1:9000/sendmail',
      key: 'v3ryStrongK3y'
    };

    mailing.sendmail(emailSettings, template, recipient, substitutions, lang, (err) => {
      assert.ok(err != null);
    });
  });

  describe('[ML01] using Mandrill', () => {
    const baseURL = 'https://mandrillapp.local';
    const path = '/messages/send';
    const emailSettings = {
      method: 'mandrill',
      url: baseURL + path,
      key: 'v3ryStrongK3y'
    };

    describe('[ML02] validating request body', () => {
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
        assert.ok(requestBody != null);
      });

      it('[8JJU] should contain a valid auth key', () => {
        assert.strictEqual(requestBody.key, emailSettings.key);
      });

      it('[G906] should contain a valid recipient', () => {
        assert.deepStrictEqual(requestBody.message.to, [recipient]);
      });

      it('[KBE0] should contain a valid substitution of variables', () => {
        assert.deepStrictEqual(requestBody.message.global_merge_vars, [
          { name: 'name', content: recipient.name },
          { name: 'email', content: recipient.email }
        ]);
      });

      it('[2ABY] should contain valid tags', () => {
        assert.deepStrictEqual(requestBody.message.tags, [template]);
      });
    });
  });

  describe('[ML03] using Microservice', () => {
    const baseURL = 'https://127.0.0.1:9000/sendmail/';
    const path = '/' + template + '/' + lang;
    const emailSettings = {
      method: 'microservice',
      url: baseURL,
      key: 'v3ryStrongK3y'
    };

    describe('[ML04] validating request body', () => {
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
        assert.ok(requestBody != null);
      });

      it('[9UEU] should contain a valid auth key', () => {
        assert.strictEqual(requestBody.key, emailSettings.key);
      });

      it('[1Y6K] should contain a valid recipient', () => {
        assert.strictEqual(requestBody.to.name, recipient.name);
        assert.strictEqual(requestBody.to.email, recipient.email);
      });

      it('[UT8M] should contain a valid substitution of variables', () => {
        assert.deepStrictEqual(requestBody.substitutions, substitutions);
      });
    });
  });
});
