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

  // The rendered provider URL can carry the phone and, for a verify, the code;
  // the provider's answer is the provider's. Neither may reach the logs nor
  // the API client.
  describe('[MFPR] provider request failures', () => {
    const URL_WITH_SECRETS = 'https://sms.example:8443/v1/verify?to=%2B41791234567&code=482913';
    let originalFetch, logged, svc;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
      logged = [];
      svc = new Service({});
      svc.logger = { error: (...args) => logged.push(JSON.stringify(args)), warn: () => {}, info: () => {}, debug: () => {} };
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    async function failure (promise) {
      try {
        await promise;
      } catch (err) {
        return err;
      }
      assert.fail('the request should have failed');
    }
    function assertNothingLeaked (err) {
      const all = logged.join('\n') + '\n' + err.message + JSON.stringify(err.data ?? null);
      for (const secret of ['/v1/verify', '41791234567', '482913', 'code=', 'provider-said-something', 'sms-down']) {
        assert.notInclude(all, secret);
      }
      assert.strictEqual(err.data?.id, 'mfa-sms-provider-error');
    }

    it('[MFPR1] a refusal logs the host and status only, and the API error has no provider body', async () => {
      globalThis.fetch = async () => new Response('{"id":"sms-down","message":"provider-said-something +41791234567"}', { status: 500 });
      const err = await failure(svc._makeRequest('POST', URL_WITH_SECRETS, {}, '{"to":"+41791234567"}'));
      assert.lengthOf(logged, 1);
      assert.include(logged[0], 'sms.example:8443');
      assert.include(logged[0], '500');
      assert.include(err.message, 'refused');
      assertNothingLeaked(err);
    });

    it('[MFPR2] a transport failure logs the host and an error code only', async () => {
      globalThis.fetch = async (url) => { throw new TypeError(`fetch failed for ${url}: provider-said-something`, { cause: { code: 'ECONNREFUSED' } }); };
      const err = await failure(svc._makeRequest('GET', URL_WITH_SECRETS, {}, null));
      assert.lengthOf(logged, 1);
      assert.include(logged[0], 'sms.example:8443');
      assert.include(logged[0], 'ECONNREFUSED');
      assertNothingLeaked(err);
    });

    it('[MFPR3] a 2xx answer is returned as is', async () => {
      globalThis.fetch = async () => new Response('ok', { status: 200 });
      const res = await svc._makeRequest('POST', URL_WITH_SECRETS, {}, '');
      assert.strictEqual(await res.text(), 'ok');
      assert.lengthOf(logged, 0);
    });
  });

  describe('[MFCT] content type of an object body', () => {
    let originalFetch, sent, svc;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
      sent = [];
      globalThis.fetch = async (url, init) => { sent.push(init); return new Response('', { status: 200 }); };
      svc = new Service({});
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    const contentTypeNames = (init) => Object.keys(init.headers).filter((n) => n.toLowerCase() === 'content-type');

    it('[MFCT1] a declared content type, whatever the case of its name, is kept and not sent twice', async () => {
      for (const name of ['content-type', 'Content-Type', 'CONTENT-TYPE']) {
        await svc._makeRequest('POST', 'https://sms.example/send', { [name]: 'application/vnd.sms+json' }, { to: '+41791234567' });
        const init = sent[sent.length - 1];
        assert.deepEqual(contentTypeNames(init), [name]);
        assert.strictEqual(init.headers[name], 'application/vnd.sms+json');
        assert.strictEqual(new Headers(init.headers).get('content-type'), 'application/vnd.sms+json');
        assert.strictEqual(init.body, '{"to":"+41791234567"}');
      }
    });

    it('[MFCT2] without a declared content type, an object body is sent as application/json', async () => {
      await svc._makeRequest('POST', 'https://sms.example/send', { authorization: 'k' }, { to: '+41791234567' });
      assert.deepEqual(contentTypeNames(sent[0]), ['Content-Type']);
      assert.strictEqual(sent[0].headers['Content-Type'], 'application/json');
    });
  });
});
