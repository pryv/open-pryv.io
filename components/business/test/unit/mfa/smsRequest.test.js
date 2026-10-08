/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;

const {
  isValidCode, smsEnrolmentContent, checkNoEnrolmentContent,
  renderUrl, renderHeaders, renderBody, CONTENT_MAX_BYTES
} = require('../../../src/mfa/smsRequest.ts');
const ChallengeVerifyService = require('../../../src/mfa/ChallengeVerifyService.ts').default;

const UNSAFE = 'a&b"c\r\nd';

function assertRefused (fn, id = 'invalid-mfa-content') {
  try {
    fn();
  } catch (err) {
    assert.strictEqual(err.id, 'invalid-parameters-format', err.message);
    assert.strictEqual(err.data?.id, id, err.message);
    return err;
  }
  assert.fail('expected a refusal');
}

describe('[MSRQ] mfa/smsRequest: inputs and rendering of SMS provider requests', () => {
  describe('[MSRU] URL', () => {
    it('[MSRU1] a value is URL-encoded where it lands', () => {
      const out = renderUrl('https://sms.example/send?to={{ phone }}&lang=en', { phone: UNSAFE });
      assert.strictEqual(out, 'https://sms.example/send?to=a%26b%22c%0D%0Ad&lang=en');
      assert.strictEqual(new URL(out).searchParams.get('to'), UNSAFE);
      assert.strictEqual(new URL(out).searchParams.get('lang'), 'en');
    });

    it('[MSRU2] a substituted value is not expanded again; an unknown placeholder stays as written', () => {
      const values = { phone: '{{ code }}', code: '1234' };
      assert.strictEqual(renderUrl('/s?to={{ phone }}&c={{ code }}&x={{ other }}', values),
        '/s?to=%7B%7B%20code%20%7D%7D&c=1234&x={{ other }}');
      assert.strictEqual(renderBody('to {{ phone }} code {{ code }}', values, { 'content-type': 'text/plain' }),
        'to {{ code }} code 1234');
    });

    it('[MSRU3] a key of the object prototype is not a value', () => {
      assert.strictEqual(renderUrl('/s?{{ constructor }}', {}), '/s?{{ constructor }}');
    });
  });

  describe('[MSRB] body', () => {
    it('[MSRB1] a JSON body (declared, or JSON text without a declared type) gets JSON string escaping', () => {
      for (const headers of [{ 'Content-Type': 'application/json; charset=utf-8' }, {}, { 'content-type': 'application/vnd.api+json' }]) {
        const out = renderBody('{ "to": "{{ phone }}", "text": "code {{ code }}" }', { phone: UNSAFE, code: '1234' }, headers);
        const parsed = JSON.parse(out);
        assert.strictEqual(parsed.to, UNSAFE, JSON.stringify(headers));
        assert.strictEqual(parsed.text, 'code 1234');
        assert.deepStrictEqual(Object.keys(parsed), ['to', 'text'], 'no key added');
      }
    });

    it('[MSRB2] a form body is form-encoded', () => {
      const out = renderBody('to={{ phone }}&text=hi', { phone: 'a&b=c"\r\n' }, { 'content-type': 'application/x-www-form-urlencoded' });
      assert.strictEqual(out, 'to=a%26b%3Dc%22%0D%0A&text=hi');
      const form = new URLSearchParams(out);
      assert.strictEqual(form.get('to'), 'a&b=c"\r\n');
      assert.deepStrictEqual([...form.keys()], ['to', 'text']);
    });

    it('[MSRB3] a plain-text body takes the value as is', () => {
      assert.strictEqual(renderBody('code {{ code }}', { code: '1234' }, {}), 'code 1234');
    });

    it('[MSRB4] an object body is substituted on its string leaves only, and not mutated', () => {
      const body = { to: '{{ phone }}', n: 3, list: ['{{ phone }}', 4], nested: { text: 'code {{ code }}' } };
      const out = renderBody(body, { phone: UNSAFE, code: '1234' }, {});
      assert.deepStrictEqual(out, { to: UNSAFE, n: 3, list: [UNSAFE, 4], nested: { text: 'code 1234' } });
      assert.strictEqual(body.to, '{{ phone }}');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(out)).to, UNSAFE);
    });
  });

  describe('[MSRH] headers', () => {
    it('[MSRH1] a value with CR, LF or another non-printable character is refused', () => {
      for (const v of ['a\r\nX-Injected: 1', 'a\nb', 'a\u0000', 'tab\there', 'é']) {
        assertRefused(() => renderHeaders({ 'x-to': 'to {{ phone }}' }, { phone: v }));
      }
    });

    it('[MSRH2] a printable value is substituted; other headers are kept', () => {
      const out = renderHeaders({ 'x-to': 'to {{ phone }}', authorization: 'secret', 'x-n': 3 }, { phone: '+41791234567' });
      assert.deepStrictEqual(out, { 'x-to': 'to +41791234567', authorization: 'secret', 'x-n': 3 });
    });
  });

  describe('[MSRC] client inputs', () => {
    it('[MSRC1] a code is 4 to 10 digits', () => {
      for (const ok of ['1234', '000000', '0123456789']) assert.isTrue(isValidCode(ok), ok);
      for (const bad of ['123', '12345678901', '12a4', '1234&', '12"34', '1234%0d%0a', '1234\r\n', '{{ phone }}', ' 1234', 1234, null, ['1234']]) {
        assert.isFalse(isValidCode(bad), JSON.stringify(bad));
      }
    });

    it('[MSRC2] the SMS content is an E.164 phone, plus allow-listed string keys within the size cap', () => {
      assert.deepStrictEqual(smsEnrolmentContent({ phone: '+41791234567' }, []), { phone: '+41791234567' });
      for (const phone of ['+1 555 1234567', '41791234567', '+0791234567', '+15551', '+1234567890123456', '+4179123456\n']) {
        assertRefused(() => smsEnrolmentContent({ phone }, []));
      }
      assertRefused(() => smsEnrolmentContent({}, []));
      assertRefused(() => smsEnrolmentContent({ phone: 41791234567 }, []));
      assertRefused(() => smsEnrolmentContent({ phone: '+41791234567', language: 'fr' }, []));
      assert.deepStrictEqual(smsEnrolmentContent({ phone: '+41791234567', language: 'fr' }, ['language']),
        { phone: '+41791234567', language: 'fr' });
      assertRefused(() => smsEnrolmentContent({ phone: '+41791234567', language: { $ne: '' } }, ['language']));
      assertRefused(() => smsEnrolmentContent({ phone: '+41791234567', language: 'x'.repeat(CONTENT_MAX_BYTES) }, ['language']));
    });

    it('[MSRC3] the method and step-up fields are never content', () => {
      assert.deepStrictEqual(smsEnrolmentContent({ method: 'sms', phone: '+41791234567', password: 'p', code: '1234' }, []),
        { phone: '+41791234567' });
      checkNoEnrolmentContent({ method: 'totp', password: 'p', code: '123456' });
      assertRefused(() => checkNoEnrolmentContent({ method: 'totp', phone: '+41791234567' }));
    });
  });

  describe('[MSCV] challenge-verify provider requests on the wire', () => {
    let sent, originalFetch;
    beforeEach(() => {
      sent = [];
      originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        sent.push({ url, init });
        return new Response('{}', { status: 200 });
      };
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    function service (verifyHeaders = { 'content-type': 'application/json' }) {
      return new ChallengeVerifyService({
        sms: {
          endpoints: {
            challenge: { url: 'https://sms.example/c?note={{ note }}', method: 'POST', headers: { 'x-note': '{{ note }}' }, body: '{"to":"{{ phone }}"}' },
            verify: { url: 'https://sms.example/v?to={{ phone }}&code={{ code }}', method: 'POST', headers: verifyHeaders, body: '{"to":"{{ phone }}","note":"{{ note }}","code":"{{ code }}"}' }
          }
        }
      });
    }
    const profile = { content: { phone: '+41791234567', note: UNSAFE } };

    it('[MSCV1] verify sends the stored content and the code only, encoded for URL and JSON body', async () => {
      await service().verify('alice', profile, { body: { code: '1234', phone: '+10000000000', extra: 'x' } });
      assert.strictEqual(sent.length, 1);
      const url = new URL(sent[0].url);
      assert.strictEqual(url.searchParams.get('to'), '+41791234567', 'the stored phone, not one from the request');
      assert.strictEqual(url.searchParams.get('code'), '1234');
      assert.notInclude(sent[0].url, '"');
      const body = JSON.parse(sent[0].init.body);
      assert.deepStrictEqual(body, { to: '+41791234567', note: UNSAFE, code: '1234' });
      assert.notInclude(sent[0].init.body, 'extra');
    });

    it('[MSCV2] verify refuses a malformed code before any request', async () => {
      for (const code of ['12&4', '1234"', '%0d%0a', '{{ phone }}', undefined]) {
        try {
          await service().verify('alice', profile, { body: { code } });
          assert.fail('expected a refusal');
        } catch (err) {
          assert.strictEqual(err.data?.id, 'invalid-mfa-code', String(code));
        }
      }
      assert.strictEqual(sent.length, 0);
    });

    it('[MSCV3] a header value with CR/LF is refused and nothing is sent', async () => {
      try {
        await service().challenge('alice', profile, { body: {} });
        assert.fail('expected a refusal');
      } catch (err) {
        assert.strictEqual(err.data?.id, 'invalid-mfa-content');
      }
      assert.strictEqual(sent.length, 0);
    });
  });
});
