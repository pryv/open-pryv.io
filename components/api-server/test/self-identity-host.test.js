/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import assert from 'node:assert';
import { selfIdentityHost } from '../src/methods/helpers/selfIdentityHost.ts';

function configOf (values) {
  return { get: (k) => values[k] };
}

describe('[SIDH] methods/helpers/selfIdentityHost', function () {
  it('[SIH1] must use dns:domain first', function () {
    const config = configOf({
      'dns:domain': 'pryv.me',
      'service:api': 'https://{username}.other.com/',
      'core:url': 'https://core-a.pryv.me'
    });
    assert.strictEqual(selfIdentityHost(config), 'pryv.me');
  });

  it('[SIH2] must use the host of service:api when dns:domain is not set', function () {
    const config = configOf({
      'service:api': 'https://api.example.com/{username}/',
      'core:url': 'https://core.example.com'
    });
    assert.strictEqual(selfIdentityHost(config), 'api.example.com');
  });

  it('[SIH3] must use the host of service:register when service:api is not set', function () {
    const config = configOf({ 'service:register': 'https://reg.example.com/reg/' });
    assert.strictEqual(selfIdentityHost(config), 'reg.example.com');
  });

  it('[SIH4] must use the host of core:url on a dnsLess core configured with core.url only', function () {
    const config = configOf({ 'core:url': 'https://single.example.com:8443' });
    assert.strictEqual(selfIdentityHost(config), 'single.example.com:8443');
  });

  it('[SIH5] must fall back to localhost when nothing usable is configured', function () {
    assert.strictEqual(selfIdentityHost(configOf({})), 'localhost');
    assert.strictEqual(selfIdentityHost(configOf({ 'core:url': 'not a url' })), 'localhost');
  });

  it('[SIH6] must resolve a {username} template with the given username, else with a placeholder', function () {
    const config = configOf({ 'service:api': 'https://{username}.example.com/' });
    assert.strictEqual(selfIdentityHost(config, 'alice'), 'alice.example.com');
    assert.strictEqual(selfIdentityHost(config), 'x.example.com');
  });

  it('[SIH7] must try the next source when service:api is set but does not parse', function () {
    const config = configOf({
      'service:api': 'not a url',
      'service:register': 'https://reg.example.com/',
      'core:url': 'https://core.example.com'
    });
    assert.strictEqual(selfIdentityHost(config), 'reg.example.com');
    assert.strictEqual(selfIdentityHost(configOf({ 'service:api': 'not a url', 'core:url': 'https://core.example.com' })), 'core.example.com');
  });
});
