/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADSC] scopes of administrator grants: the grammar, where a core sits in
 * the `hostings` hierarchy, which scopes cover a core or a set of regions,
 * and orphans. On a three-region fixture and on a platform without
 * `hostings`.
 */

import assert from 'node:assert/strict';
import {
  parseScope, isScope, coreContext, scopeCoversCore, scopeCoversRegions, scopeState, hostingsOf, placeHosting, describeHostings
} from '../../src/admin/scopes.ts';
import { coreRegion } from 'oauth2/src/clientRegistry.ts';

const HOSTINGS = {
  regions: {
    europe: { zones: { ch: { hostings: { 'ch-gva': {}, 'ch-zrh': {} } }, de: { hostings: { 'de-fra': {} } } } },
    america: { zones: { us: { hostings: { 'us-east': {} } } } },
    asia: { zones: { sg: { hostings: { 'sg-1': {} } } } }
  }
};

function configOf (values) {
  return { get: (k) => values[k] };
}

const gva = coreContext(configOf({ 'core:id': 'core-gva', 'core:hosting': 'ch-gva', hostings: HOSTINGS }));
const fra = coreContext(configOf({ 'core:id': 'core-fra', 'core:hosting': 'de-fra', hostings: HOSTINGS }));
const usa = coreContext(configOf({ 'core:id': 'core-us', 'core:hosting': 'us-east', hostings: HOSTINGS }));
const unlisted = coreContext(configOf({ 'core:id': 'core-x', 'core:hosting': 'nowhere', hostings: HOSTINGS }));
const flat = coreContext(configOf({ 'core:id': 'core-a', hostings: null }));
const flatNamed = coreContext(configOf({ 'core:id': 'core-b', 'core:hosting': 'rack-2' }));

describe('[ADSC] administrator grant scopes', function () {
  it('[ADSC1] grammar: platform or kind:id, id 1 to 128 of A-Z a-z 0-9 . _ -', () => {
    assert.deepEqual(parseScope('platform'), { kind: 'platform' });
    assert.deepEqual(parseScope('region:europe'), { kind: 'region', id: 'europe' });
    assert.deepEqual(parseScope('zone:ch'), { kind: 'zone', id: 'ch' });
    assert.deepEqual(parseScope('hosting:ch-gva'), { kind: 'hosting', id: 'ch-gva' });
    assert.deepEqual(parseScope('core:core_1.a'), { kind: 'core', id: 'core_1.a' });
    assert.ok(isScope('core:' + 'a'.repeat(128)));
    for (const bad of ['', 'Platform', 'platform:x', 'core:', 'core:' + 'a'.repeat(129), 'core:a b', 'core:a/b', 'country:ch',
      'region:europe ', ' region:europe', 'region:eu:rope', null, undefined, 42, {}, ['platform']]) {
      assert.equal(parseScope(bad), null, JSON.stringify(bad));
      assert.equal(isScope(bad), false, JSON.stringify(bad));
    }
  });

  it('[ADSC2] core context: id, hosting, zone and region from core.hosting and the hierarchy', () => {
    assert.deepEqual({ ...gva, regions: [...gva.regions] },
      { coreId: 'core-gva', hosting: 'ch-gva', zone: 'ch', region: 'europe', regions: ['europe', 'america', 'asia'], hierarchy: true });
    assert.equal(fra.zone, 'de');
    assert.equal(usa.region, 'america');
    assert.equal(unlisted.zone, null, 'a hosting the hierarchy does not list has no zone');
    assert.equal(unlisted.region, null);
    assert.deepEqual({ ...flat, regions: [...flat.regions] },
      { coreId: 'core-a', hosting: 'default', zone: null, region: null, regions: [], hierarchy: false });
    assert.equal(coreContext(configOf({})).coreId, 'single', 'the platform layer\'s single-core id');
    assert.equal(flatNamed.hosting, 'rack-2');
  });

  it('[ADSC3] covers a core: platform everywhere; region, zone, hosting and core where the core sits', () => {
    const covers = (scope) => [gva, fra, usa].filter((c) => scopeCoversCore(scope, c)).map((c) => c.coreId);
    assert.deepEqual(covers('platform'), ['core-gva', 'core-fra', 'core-us']);
    assert.deepEqual(covers('region:europe'), ['core-gva', 'core-fra']);
    assert.deepEqual(covers('region:america'), ['core-us']);
    assert.deepEqual(covers('zone:ch'), ['core-gva']);
    assert.deepEqual(covers('zone:de'), ['core-fra']);
    assert.deepEqual(covers('hosting:ch-gva'), ['core-gva']);
    assert.deepEqual(covers('hosting:ch-zrh'), [], 'a known hosting without a core here');
    assert.deepEqual(covers('core:core-us'), ['core-us']);
    assert.deepEqual(covers('core:core-zz'), []);
    assert.deepEqual(covers('not a scope'), []);
  });

  it('[ADSC4] unknown ids never match, prototype keys included', () => {
    for (const scope of ['region:nowhere', 'zone:nowhere', 'hosting:nowhere', 'region:__proto__', 'zone:__proto__',
      'hosting:__proto__', 'hosting:constructor', 'region:toString']) {
      assert.equal(scopeCoversCore(scope, gva), false, scope);
      assert.equal(scopeCoversCore(scope, unlisted), false, scope);
    }
    // A core on a hosting the hierarchy does not list: only platform and its own core id.
    assert.equal(scopeCoversCore('hosting:nowhere', unlisted), false);
    assert.equal(scopeCoversCore('core:core-x', unlisted), true);
    assert.equal(scopeCoversCore('platform', unlisted), true);
    assert.equal(placeHosting(hostingsOf(configOf({ hostings: HOSTINGS })), '__proto__'), null);
  });

  it('[ADSC5] without a hostings hierarchy: only platform, hosting:default and core:<id> match', () => {
    assert.equal(scopeCoversCore('platform', flat), true);
    assert.equal(scopeCoversCore('hosting:default', flat), true);
    assert.equal(scopeCoversCore('core:core-a', flat), true);
    assert.equal(scopeCoversCore('core:core-b', flat), false);
    assert.equal(scopeCoversCore('region:default', flat), false);
    assert.equal(scopeCoversCore('zone:default', flat), false);
    // A named hosting without a hierarchy is not addressable by hosting scope.
    assert.equal(scopeCoversCore('hosting:rack-2', flatNamed), false);
    assert.equal(scopeCoversCore('hosting:default', flatNamed), false);
    assert.equal(scopeCoversCore('core:core-b', flatNamed), true);
  });

  it('[ADSC6] covers regions: platform always; region:<r> when every listed region is r; nothing else; no regions needs platform', () => {
    const h = hostingsOf(configOf({ hostings: HOSTINGS }));
    assert.equal(scopeCoversRegions('platform', ['europe', 'asia'], h), true);
    assert.equal(scopeCoversRegions('platform', null, h), true);
    assert.equal(scopeCoversRegions('region:europe', ['europe'], h), true);
    assert.equal(scopeCoversRegions('region:europe', ['europe', 'europe'], h), true);
    assert.equal(scopeCoversRegions('region:europe', ['europe', 'asia'], h), false);
    assert.equal(scopeCoversRegions('region:europe', [], h), false, 'all regions');
    assert.equal(scopeCoversRegions('region:europe', undefined, h), false, 'all regions');
    assert.equal(scopeCoversRegions('region:nowhere', ['nowhere'], h), false, 'an orphan region');
    assert.equal(scopeCoversRegions('region:default', ['default'], null), false, 'no hierarchy: no region scope');
    for (const scope of ['zone:ch', 'hosting:ch-gva', 'core:core-gva']) {
      assert.equal(scopeCoversRegions(scope, ['europe'], h), false, scope);
    }
  });

  it('[ADSC7] scope state: ok or orphan, with and without a hierarchy', () => {
    const h = hostingsOf(configOf({ hostings: HOSTINGS }));
    const cores = ['core-gva', 'core-fra', 'core-us'];
    for (const scope of ['platform', 'region:asia', 'zone:sg', 'hosting:ch-zrh', 'core:core-fra']) {
      assert.equal(scopeState(scope, h, cores), 'ok', scope);
    }
    for (const scope of ['region:nowhere', 'zone:nowhere', 'hosting:nowhere', 'core:core-zz', 'zone:__proto__', 'bogus']) {
      assert.equal(scopeState(scope, h, cores), 'orphan', scope);
    }
    assert.equal(scopeState('hosting:default', null, ['core-a']), 'ok');
    assert.equal(scopeState('hosting:rack-2', null, ['core-a']), 'orphan');
    assert.equal(scopeState('region:default', null, ['core-a']), 'orphan');
    assert.equal(scopeState('zone:ch', null, ['core-a']), 'orphan');
    assert.equal(scopeState('core:core-a', null, ['core-a']), 'ok');
  });

  it('[ADSC9] a zone key in two regions or a hosting key in two zones is a problem; a valid hierarchy has none', () => {
    assert.deepEqual(describeHostings(configOf({ hostings: HOSTINGS })), []);
    assert.deepEqual(describeHostings(configOf({ hostings: null })), []);
    const dupZone = describeHostings(configOf({
      hostings: { regions: { europe: { zones: { a: { hostings: { h1: {} } } } }, america: { zones: { a: { hostings: { h2: {} } } } } } }
    }));
    assert.equal(dupZone.length, 1);
    assert.deepEqual(dupZone[0].path, ['hostings', 'regions', 'america', 'zones', 'a']);
    assert.match(dupZone[0].message, /europe/);
    const dupHosting = describeHostings(configOf({
      hostings: { regions: { europe: { zones: { ch: { hostings: { h1: {} } }, de: { hostings: { h1: {} } } } } } }
    }));
    assert.equal(dupHosting.length, 1);
    assert.deepEqual(dupHosting[0].path, ['hostings', 'regions', 'europe', 'zones', 'de', 'hostings', 'h1']);
    assert.match(dupHosting[0].message, /europe\.ch/);
  });

  it('[ADSC8] the OAuth client region of a core is the same walk (default without a hierarchy)', () => {
    assert.equal(coreRegion(configOf({ 'core:hosting': 'ch-zrh', hostings: HOSTINGS })), 'europe');
    assert.equal(coreRegion(configOf({ 'core:hosting': 'nowhere', hostings: HOSTINGS })), null);
    assert.equal(coreRegion(configOf({ hostings: null })), 'default');
  });
});
