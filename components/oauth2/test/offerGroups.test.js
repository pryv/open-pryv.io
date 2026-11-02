/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OSG] OAuth2: grouped consent entries (`entryGroups`) and the whole-offer
 * size bound. A grammar may group the entries of its offer for display; the
 * core checks the groups' shape and bounds when it parses the offer, passes
 * them on unchanged otherwise, and refuses any offer over the size bound.
 * Every refusal is a contract error: `invalid_scope` with a generic text,
 * the detail on the server trail.
 */

import assert from 'node:assert/strict';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import { checkRegistryClients } from '../src/registryBootCheck.ts';
import { setClient } from '../src/storage.ts';

const CLIENT = {
  clientId: 'grp-app',
  kind: 'registry',
  redirectUris: ['https://app.example.com/redirect'],
  scope: ['read/a', 'read/b'],
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethod: 'none',
  subjectType: 'public',
  updatedAt: 1,
};

const GROUPS = [
  { key: 'first', label: { en: 'First', fr: 'Premier' }, entries: ['s|a', 's|c|read'] },
  { key: 'second', label: { en: 'Second' }, entries: ['s|b|read', 'f|webhooks'] },
];

// `read/<s>` reads one stream; the offer's extra members come from `extra`
// (request parses only, unless `target` says `max`).
let extra = {};
let target = 'request';

function grammar () {
  return {
    apiVersion: 1,
    name: 'toy-groups',
    scopeGrammar: {
      parse (scopeString, ctx) {
        const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
        if (tokens.some((t) => !t.startsWith('read/'))) return { ok: false, description: 'unknown token' };
        const permissions = tokens.map((t) => ({ streamId: t.slice(5), level: 'read' }));
        const more = ctx.purpose === target ? extra : {};
        return { ok: true, tokens, offer: { permissions, ...more } };
      },
      echo ({ requestedTokens }) { return requestedTokens; },
    },
  };
}

/** Resolve with console.error captured: the result and the logged lines. */
function resolve (scope = 'read/a read/b') {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  try {
    return { r: scopeGrammar.resolveRequestedScope(CLIENT, scope), logged };
  } finally {
    console.error = orig;
  }
}

function assertContractError ({ r, logged }, detail) {
  assert.equal(r.ok, false);
  assert.equal(r.description, 'scope could not be parsed');
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0], /contract error in scopeGrammar\.parse \(request\)/);
  assert.match(logged[0], detail);
}

function manyGroups (n, perGroup = 1) {
  return Array.from({ length: n }, (_v, i) => ({
    key: 'g' + i, label: { en: 'Group ' + i }, entries: Array.from({ length: perGroup }, (_w, j) => 's|x' + i + '-' + j),
  }));
}

describe('[OSG] OAuth2: grouped consent entries and the offer size bound', () => {
  beforeEach(() => {
    extra = {};
    target = 'request';
    extension.setExtension(grammar());
    scopeGrammar._resetForTests();
  });
  afterEach(() => {
    extension._resetForTests();
  });

  it('[OSG1] valid groups reach the resolved offer unchanged, in order, keys outside the offer and level-less keys included; they count in the digest', () => {
    const plain = resolve();
    assert.equal(plain.r.ok, true, plain.r.description);
    assert.equal(plain.r.offer.entryGroups, undefined);

    extra = { entryGroups: GROUPS, entryLabels: { 's|a': { en: 'A' }, 's|b|read': { en: 'B' } } };
    const { r, logged } = resolve();
    assert.equal(r.ok, true, r.description);
    assert.deepEqual(logged, []);
    assert.deepEqual(r.offer.entryGroups, GROUPS);
    assert.deepEqual(r.offer.entryLabels, { 's|a': { en: 'A' }, 's|b|read': { en: 'B' } });
    assert.deepEqual(r.offer.permissions, plain.r.offer.permissions);
    assert.notEqual(r.digest, plain.r.digest);

    // The order is the display order: regrouping changes the digest.
    extra = { entryGroups: [GROUPS[1], GROUPS[0]] };
    const swapped = resolve();
    assert.equal(swapped.r.ok, true);
    extra = { entryGroups: GROUPS };
    assert.notEqual(resolve().r.digest, swapped.r.digest);

    // Edge of the bounds: 64 groups, 1000 keys, an empty list, other members dropped.
    extra = { entryGroups: manyGroups(64) };
    assert.equal(resolve().r.ok, true);
    extra = { entryGroups: manyGroups(50, 20) };
    assert.equal(resolve().r.ok, true);
    extra = { entryGroups: [] };
    assert.deepEqual(resolve().r.offer.entryGroups, []);
    extra = { entryGroups: [{ ...GROUPS[0], color: 'red' }] };
    const stray = resolve().r;
    assert.deepEqual(stray.offer.entryGroups, [GROUPS[0]]);
    // Typed before the digest: a dropped member never changes it.
    extra = { entryGroups: [GROUPS[0]] };
    assert.equal(resolve().r.digest, stray.digest);
  });

  it('[OSG2] more than 64 groups are refused', () => {
    extra = { entryGroups: manyGroups(65) };
    assertContractError(resolve(), /more than 64 groups/);
  });

  it('[OSG3] an entry key in two groups (or twice in one), or a group key used twice, is refused', () => {
    extra = { entryGroups: [GROUPS[0], { key: 'other', label: { en: 'Other' }, entries: ['s|b', 's|a'] }] };
    assertContractError(resolve(), /entry key s\|a appears in more than one group/);
    extra = { entryGroups: [{ key: 'one', label: {}, entries: ['s|a', 's|a'] }] };
    assertContractError(resolve(), /entry key s\|a appears in more than one group/);
    extra = { entryGroups: [GROUPS[0], { ...GROUPS[1], key: 'first' }] };
    assertContractError(resolve(), /group key first appears more than once/);
  });

  it('[OSG4] malformed groups are refused: a label value that is not a string, and every other shape rule', () => {
    extra = { entryGroups: [{ key: 'g', label: { en: 3 }, entries: [] }] };
    assertContractError(resolve(), /label values must be strings/);
    const cases = [
      [{ entryGroups: null }, /must be an array/],
      [{ entryGroups: { g: GROUPS[0] } }, /must be an array/],
      [{ entryGroups: ['g'] }, /group 0 is not an object/],
      [{ entryGroups: [{ label: {}, entries: [] }] }, /key must be a string of 1 to 64/],
      [{ entryGroups: [{ key: '', label: {}, entries: [] }] }, /key must be a string of 1 to 64/],
      [{ entryGroups: [{ key: 'k'.repeat(65), label: {}, entries: [] }] }, /key must be a string of 1 to 64/],
      [{ entryGroups: [{ key: 'g', label: ['en'], entries: [] }] }, /label must be an object/],
      [{ entryGroups: [{ key: 'g', entries: [] }] }, /label must be an object/],
      [{ entryGroups: [{ key: 'g', label: { en: 'x'.repeat(201) }, entries: [] }] }, /at most 200 characters/],
      [{ entryGroups: [{ key: 'g', label: Object.fromEntries(Array.from({ length: 17 }, (_v, i) => ['l' + i, 'x'])), entries: [] }] }, /more than 16 languages/],
      [{ entryGroups: [{ key: 'g', label: {}, entries: 's|a' }] }, /entries must be an array/],
      [{ entryGroups: [{ key: 'g', label: {}, entries: [7] }] }, /entry keys must be strings of 1 to 300/],
      [{ entryGroups: [{ key: 'g', label: {}, entries: [''] }] }, /entry keys must be strings of 1 to 300/],
      [{ entryGroups: [{ key: 'g', label: {}, entries: ['s|' + 'a'.repeat(299)] }] }, /entry keys must be strings of 1 to 300/],
    ];
    for (const [offer, detail] of cases) {
      extra = offer;
      assertContractError(resolve(), detail);
    }
    // Bounds hold on the maximum set's parse too (fresh caches: the cases
    // above must not have memoised a maximum set).
    scopeGrammar._resetForTests();
    target = 'max';
    extra = { entryGroups: manyGroups(65) };
    const { r } = resolve();
    assert.equal(r.ok, false);
    assert.match(r.description, /registered scope is refused: scope could not be parsed/);
  });

  it('[OSG5] more than 1000 entry keys across groups are refused', () => {
    extra = { entryGroups: manyGroups(50, 20).concat([{ key: 'last', label: {}, entries: ['s|one-more'] }]) };
    assertContractError(resolve(), /more than 1000 entry keys across groups/);
  });

  it('[OSG6] an offer over 256 KiB of canonical JSON is refused, labels and texts included; one at the bound passes', () => {
    const labels = (bytes) => ({ 's|a': { en: 'x'.repeat(bytes) } });
    // Size of the offer around a label of n characters.
    extra = { entryLabels: labels(0) };
    const base = Buffer.byteLength(scopeGrammar.canonicalJson(resolve().r.offer));
    const room = scopeGrammar.MAX_SYNTH_OFFER_BYTES - base;
    extra = { entryLabels: labels(room) };
    const at = resolve();
    assert.equal(at.r.ok, true, at.r.description);
    assert.equal(Buffer.byteLength(scopeGrammar.canonicalJson(at.r.offer)), scopeGrammar.MAX_SYNTH_OFFER_BYTES);
    extra = { entryLabels: labels(room + 1) };
    assertContractError(resolve(), /over the bound of 262144/);
    // Counted in bytes, not characters.
    extra = { description: { en: 'é'.repeat(Math.ceil(room / 2) + 50) } };
    assertContractError(resolve(), /over the bound of 262144/);
  });

  it('[OSG10] an offer that is not JSON is a contract error, never a throw: a bad registered scope at the boot check leaves the other clients checked', async () => {
    extra = { consent: { en: 1n } };
    assertContractError(resolve(), /the offer is not JSON/);
    const cyclic = {};
    cyclic.self = cyclic;
    extra = { entryLabels: cyclic };
    assertContractError(resolve(), /the offer is not JSON/);

    // A cyclic member in one client's maximum-set offer.
    const toy = grammar();
    extension.setExtension({
      ...toy,
      scopeGrammar: {
        ...toy.scopeGrammar,
        parse (s, ctx) {
          const out = toy.scopeGrammar.parse(s, ctx);
          if (out.ok && ctx.purpose === 'max' && ctx.client.clientId === 'a-cyc') out.offer.consent = cyclic;
          return out;
        },
      },
    });
    const kv = new Map();
    const platform = {
      async setPlatformKv (k, v) { kv.set(k, v); },
      async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
      async listPlatformKvKeys (prefix) { return [...kv.keys()].filter((k) => k.startsWith(prefix)); },
    };
    await setClient(platform, { ...CLIENT, clientId: 'a-cyc' });
    await setClient(platform, { ...CLIENT, clientId: 'b-bad', scope: ['nope'] });
    await setClient(platform, { ...CLIENT, clientId: 'c-good' });
    const warnings = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...a) => warnings.push(a.join(' '));
    console.error = () => {};
    let count;
    try {
      count = await checkRegistryClients(platform);
    } finally {
      console.warn = origWarn;
      console.error = origError;
    }
    assert.equal(count, 2, warnings.join('\n'));
    assert.match(warnings[0], /client a-cyc: its registered scope is refused: scope could not be parsed/);
    assert.match(warnings[1], /client b-bad: its registered scope is refused/);
  });

  it('[OSG11] the echo is parsed with the same checks: invalid groups in its parse fail the token response', () => {
    const held = [{ streamId: 'a', level: 'read' }];
    assert.deepEqual(scopeGrammar.grantedScopeTokens(CLIENT, [], ['read/a'], held), ['read/a']);
    scopeGrammar._resetForTests(); // the echo's parse is memoised
    extra = { entryGroups: manyGroups(65) };
    const orig = console.error;
    console.error = () => {};
    try {
      assert.throws(() => scopeGrammar.grantedScopeTokens(CLIENT, [], ['read/a'], held),
        /scopeGrammar\.echo answered a scope its parse refuses: scope could not be parsed/);
    } finally {
      console.error = orig;
    }
  });
});
