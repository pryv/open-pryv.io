/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The per-user issuer at the oauth2 component level: the setting and its boot
 * problems, the request's issuer, the consent's issuer and account checks.
 */

import assert from 'node:assert/strict';
import { parsePerUserIssuer, perUserIssuerProblems, requestIssuer, stateIssuerRefusal, urlHost } from '../src/perUserIssuer.ts';
import { issuerAccountRefusal } from '../src/audienceAccount.ts';
import { tokenEndpointAudiences } from '../src/issuer.ts';

const CONFIGURED = 'https://core-a.example.com';

function config (values) {
  const m = { 'oauth:issuer': CONFIGURED, 'dnsLess:isActive': false, 'dns:domain': 'example.com', ...values };
  return { get: (k) => m[k] };
}

describe('[OPIU] OAuth2: the issuer derived from the request host', () => {
  it('[OPIU1] the setting: a boolean (or its string), refused on a dnsLess core, without dns.domain, or of another type', () => {
    for (const [v, expected] of [[undefined, false], [null, false], [false, false], [true, true], ['TRUE', true], [' false ', false], ['yes', null], [1, null]]) {
      assert.equal(parsePerUserIssuer(v), expected, String(v));
    }
    assert.deepEqual(perUserIssuerProblems(config({ 'oauth:perUserIssuer': true })), []);
    assert.deepEqual(perUserIssuerProblems(config({ 'oauth:perUserIssuer': false, 'dnsLess:isActive': true })), []);
    const dnsLess = perUserIssuerProblems(config({ 'oauth:perUserIssuer': true, 'dnsLess:isActive': true }));
    assert.equal(dnsLess.length, 1);
    assert.match(dnsLess[0], /dnsLess core/);
    // dnsLess left to its default (true) is a dnsLess core too.
    assert.match(perUserIssuerProblems(config({ 'oauth:perUserIssuer': 'true', 'dnsLess:isActive': undefined }))[0], /dnsLess core/);
    assert.match(perUserIssuerProblems(config({ 'oauth:perUserIssuer': true, 'dns:domain': '' }))[0], /dns\.domain is not set/);
    assert.match(perUserIssuerProblems(config({ 'oauth:perUserIssuer': 'on' }))[0], /true or false is expected/);
  });

  it('[OPIU2] the request\'s issuer: the host application\'s answer only when the switch is on; a consent step must reach the state\'s issuer', async () => {
    const mine = { issuer: 'https://alice.example.com', label: 'alice' };
    let asked = 0;
    const of = async () => { asked++; return mine; };
    assert.deepEqual(await requestIssuer(config({}), of, {}), { issuer: CONFIGURED, perUser: null });
    assert.equal(asked, 0, 'not asked while off');
    assert.deepEqual(await requestIssuer(config({ 'oauth:perUserIssuer': true }), of, {}), { issuer: mine.issuer, perUser: mine });
    assert.deepEqual(await requestIssuer(config({ 'oauth:perUserIssuer': true }), async () => null, {}), { issuer: CONFIGURED, perUser: null });
    assert.deepEqual(await requestIssuer(config({ 'oauth:perUserIssuer': true }), null, {}), { issuer: CONFIGURED, perUser: null });
    // No configured issuer: nothing is mounted, nothing is asked.
    assert.deepEqual(await requestIssuer(config({ 'oauth:perUserIssuer': true, 'oauth:issuer': '', 'service:api': '' }), of, {}), { issuer: '', perUser: null });

    const c = config({ 'oauth:perUserIssuer': true });
    const atAlice = { issuer: mine.issuer, perUser: mine };
    const atRegion = { issuer: CONFIGURED, perUser: null };
    assert.equal(stateIssuerRefusal(c, mine.issuer, atAlice), null);
    assert.equal(stateIssuerRefusal(c, undefined, atRegion), null);
    for (const [stateIssuer, current] of [[mine.issuer, atRegion], [undefined, atAlice], ['https://bob.example.com', atAlice]]) {
      const refused = stateIssuerRefusal(c, stateIssuer, current);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.reason, 'issuer-mismatch');
    }
    // The client assertion audiences follow the request's issuer.
    assert.deepEqual(tokenEndpointAudiences(c, mine.issuer), [mine.issuer, mine.issuer + '/oauth2/token']);
    assert.deepEqual(tokenEndpointAudiences(c), [CONFIGURED, CONFIGURED + '/oauth2/token']);
    for (const [v, host] of [['https://Alice.Example.com/x', 'alice.example.com'], ['https://alice.example.com./x', 'alice.example.com'],
      ['https://alice.example.com.:8443/x', 'alice.example.com:8443'], ['https://alice.example.com:443/', 'alice.example.com'], ['not a url', null]]) {
      assert.equal(urlHost(v), host, v);
    }
  });

  it('[OPIU3] at a per-user issuer only the account its host names consents: its username, or the address alias the consent adopts', () => {
    const alice = { username: 'alice', addressAliases: ['a-12345678'] };
    assert.equal(issuerAccountRefusal(null, alice, null), null, 'no per-user issuer');
    assert.equal(issuerAccountRefusal('alice', alice, null), null);
    assert.equal(issuerAccountRefusal('ALICE', alice, null), null);
    assert.equal(issuerAccountRefusal('bobby', alice, null), 'mismatch');
    assert.equal(issuerAccountRefusal('a-12345678', alice, 'a-12345678'), null, 'adopted');
    assert.equal(issuerAccountRefusal('a-12345678', alice, null), 'mismatch', 'not adopted');
    assert.equal(issuerAccountRefusal('a-12345678', alice, 'a-87654321'), 'mismatch');
    assert.equal(issuerAccountRefusal('a-87654321', alice, 'a-87654321'), 'mismatch', 'not an alias of the account');
    assert.equal(issuerAccountRefusal('alice', alice, null, (l) => l === 'alice'), 'mismatch', 'a platform name');
  });
});
