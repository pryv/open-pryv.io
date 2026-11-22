/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert */

describe('[RTOR] access request returnURL: shape and access.returnOrigins', () => {
  const { checkReturnURL } = require('business/src/auth/returnOrigins.ts');
  const ok = (setting, appId, url) => assert.strictEqual(checkReturnURL(setting, appId, url), null, String(url));
  const refused = (setting, appId, url, re) => {
    const message = checkReturnURL(setting, appId, url);
    assert.ok(typeof message === 'string', 'expected a refusal for ' + String(url));
    if (re) assert.match(message, re);
    assert.ok(!message.includes(String(url)) || String(url) === '', 'the message never echoes the value');
  };
  const SETTING = 'my-app@https://app.example.com';

  it('[RTO1] an unbound app is not restricted to any origin', () => {
    ok(undefined, 'my-app', 'https://anywhere.example.net/x');
    ok(SETTING, 'other-app', 'https://anywhere.example.net/x');
    ok('', 'my-app', 'https://anywhere.example.net/x');
  });

  it('[RTO2] a bound app may return to its origin, with any path, query and fragment', () => {
    ok(SETTING, 'my-app', 'https://app.example.com');
    ok(SETTING, 'my-app', 'https://app.example.com/some/page?x=1#');
    ok(SETTING, 'my-app', 'https://app.example.com:443/page&prYvkey=1');
  });

  it('[RTO3] a bound app is refused another origin, scheme or port', () => {
    for (const url of ['https://evil.example.net/', 'http://app.example.com/', 'https://app.example.com:8443/']) {
      refused(SETTING, 'my-app', url, /not on an origin registered/);
    }
  });

  it('[RTO4] an absent return address (poll-only) is always accepted', () => {
    for (const value of [undefined, null, false, '', 'false']) {
      ok(SETTING, 'my-app', value);
      ok('*@https://app.example.com', 'any-app', value);
    }
  });

  it('[RTO5] user info, control characters and unparsable values are refused, bound or not', () => {
    for (const setting of [undefined, SETTING]) {
      refused(setting, 'my-app', 'https://app.example.com@evil.example.net/', /not a valid URL/);
      refused(setting, 'my-app', 'https://u:p@app.example.com/', /not a valid URL/);
      refused(setting, 'my-app', 'https://app.exa\tmple.com/', /not a valid URL/);
      refused(setting, 'my-app', 'https://app.example.com/\nx', /not a valid URL/);
      refused(setting, 'my-app', '/relative/path', /not a valid URL/);
      refused(setting, 'my-app', 'not a url', /not a valid URL/);
    }
  });

  it('[RTO6] a *@ entry binds every app id', () => {
    const setting = '*@https://*.example.com';
    ok(setting, 'any-app', 'https://app.example.com/x');
    refused(setting, 'any-app', 'https://example.net/x', /not on an origin registered/);
  });

  it('[RTO7] <appId>@* exempts one app from a closed registry', () => {
    const setting = '*@https://*.example.com, free-app@*';
    ok(setting, 'free-app', 'https://example.net/x');
    refused(setting, 'other-app', 'https://example.net/x');
  });

  it('[RTO8] subdomain wildcard and :* port; look-alike hosts are refused', () => {
    const setting = 'my-app@https://*.example.com, my-app@http://localhost:*';
    ok(setting, 'my-app', 'https://a.b.example.com/x');
    ok(setting, 'my-app', 'http://localhost:5173/cb');
    for (const url of [
      'https://example.com/x', // the parent domain is not a subdomain
      'https://a.example.com.evil.net/x',
      'https://evil.net/a.example.com',
      'https://a.example.com./x', // trailing dot: not the registered host
      'http://localhost.evil.net:5173/'
    ]) {
      refused(setting, 'my-app', url);
    }
  });

  it('[RTO9] a custom scheme is allowed when registered as <scheme>://<host>', () => {
    const setting = 'mobile-app@myapp://callback';
    ok(setting, 'mobile-app', 'myapp://callback/done');
    refused(setting, 'mobile-app', 'myapp://other/done');
    refused(setting, 'mobile-app', 'otherapp://callback/done');
    ok(undefined, 'mobile-app', 'myapp://callback/done');
  });

  it('[RTO10] script-capable and local schemes are refused, key or no key, any case or leading space', () => {
    for (const setting of [undefined, '*@*']) {
      for (const url of [
        'javascript:alert(1)//', 'JavaScript:alert(1)', ' javascript:alert(1)',
        'data:text/html,<script>x</script>', 'vbscript:msgbox(1)',
        'blob:https://app.example.com/0b4c', 'file:///etc/passwd'
      ]) {
        refused(setting, 'my-app', url, /scheme that is not allowed/);
      }
    }
  });

  it('[RTO11] a non-string return address is refused', () => {
    for (const value of [true, 1, {}, ['https://app.example.com']]) {
      refused(undefined, 'my-app', value, /must be a string/);
    }
  });
});

describe('[CVRO] config-validation access.returnOrigins', () => {
  const { checkReturnOrigins } = require('../../../config/plugins/config-validation.js');
  function problemsFor (value) {
    const problems = [];
    checkReturnOrigins({ get: (key) => (key === 'access:returnOrigins' ? value : undefined) }, problems);
    return problems;
  }

  it('[CVRO1] absent is fine; a non-string or a malformed entry refuses the boot', () => {
    assert.deepStrictEqual(problemsFor(undefined), []);
    assert.deepStrictEqual(problemsFor(null), []);
    assert.deepStrictEqual(problemsFor('a@https://app.example.com, *@https://*.example.org, m@myapp://cb, x@*'), []);
    const nonString = problemsFor(['a@https://app.example.com']);
    assert.strictEqual(nonString.length, 1);
    assert.deepStrictEqual(nonString[0].path, ['access', 'returnOrigins']);
    const malformed = problemsFor('a@https://app.example.com, b@https://app.*.example.com, broken');
    assert.strictEqual(malformed.length, 2, JSON.stringify(malformed));
    assert.ok(malformed.every((p) => p.path.join('.') === 'access.returnOrigins'));
  });
});
