/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCMPU] The composed consent screen of a registry client (current grant
 * joined with the request), its digest, and the grant after the consent.
 * Pure functions; the end-to-end flow is in the api-server suite.
 */

const assert = require('node:assert/strict');
const { composeShownOffer, nextGrantPermissions, shownDigestOf } = require('../src/consentComposition.ts');
const { normalizePermissions, checkConsentGrant } = require('business/src/accesses/permissionSet.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const extension = require('../src/extension.ts');

const CLIENT = { clientId: 'reg-app', kind: 'registry', subjectType: 'public', updatedAt: 1 };
const DIGEST = 'offer-digest';

function requested (permissions, extra = {}) {
  return { offer: { permissions: normalizePermissions(permissions, { consent: true }), ...extra }, digest: DIGEST };
}

describe('[OCMPU] composed consent of registry clients', () => {
  it('[OCMPU1] no current grant: the request as is, no subject change', () => {
    const c = composeShownOffer(requested([{ streamId: 'a', level: 'read' }], { entryLabels: { 's|a|read': { en: 'A' } } }), null, CLIENT);
    assert.equal(c.ok, true);
    assert.deepEqual(c.shown.permissions, [{ streamId: 'a', level: 'read' }]);
    assert.equal(c.shown.allowUserChoice, false);
    assert.deepEqual(c.shown.entryLabels, { 's|a|read': { en: 'A' } });
    assert.equal(c.subjectChange, null);
    assert.equal(typeof c.shownDigest, 'string');
  });

  it('[OCMPU2] with a grant: one entry per stream at the join level, annotations', () => {
    const req = requested([
      { streamId: 'a', level: 'read', mandatory: true },
      { streamId: 'b', level: 'read', optIn: true },
      { streamId: 'c', level: 'contribute', optIn: true },
      { feature: 'selfAudit', setting: 'allowed', optIn: true },
    ], { allowUserChoice: true });
    const current = {
      aliased: false,
      permissions: [{ streamId: 'a', level: 'contribute' }, { streamId: 'c', level: 'read' }, { streamId: 'd', level: 'read' },
        { streamId: 'e', level: 'none' }, { feature: 'selfAudit', setting: 'allowed' }],
    };
    const c = composeShownOffer(req, current, CLIENT);
    assert.equal(c.ok, true);
    // A held entry says the level held now (c is widened by the request), and
    // is never opt-in (it opens ticked), stream or feature.
    assert.deepEqual(c.shown.permissions, [
      { streamId: 'a', level: 'contribute', mandatory: true, currentlyGranted: true, currentLevel: 'contribute' },
      { streamId: 'c', level: 'contribute', currentlyGranted: true, currentLevel: 'read' },
      { streamId: 'd', level: 'read', currentlyGranted: true, currentLevel: 'read' },
      { streamId: 'b', level: 'read', optIn: true },
      { feature: 'selfAudit', setting: 'allowed', currentlyGranted: true },
    ]);
    assert.equal(c.shown.allowUserChoice, true);
  });

  it('[OCMPU3] read held, create-only requested: a level conflict', () => {
    const c = composeShownOffer(requested([{ streamId: 'a', level: 'create-only' }]),
      { aliased: false, permissions: [{ streamId: ':local:a', level: 'read' }] }, CLIENT);
    assert.equal(c.ok, false);
    assert.equal(c.error.code, 'permission-level-conflict');
  });

  it('[OCMPU4] features: the grant\'s forbids shown locked, the core defaults never', () => {
    const req = requested([{ streamId: 'a', level: 'read' }, { feature: 'selfAudit', setting: 'allowed' }]);
    const current = {
      aliased: false,
      permissions: [{ streamId: 'a', level: 'read' }, { feature: 'selfAudit', setting: 'forbidden' },
        { feature: 'selfRevoke', setting: 'forbidden' }, { feature: 'webhooks', setting: 'forbidden' },
        { feature: 'secretSharing', setting: 'forbidden' }],
    };
    const c = composeShownOffer(req, current, CLIENT);
    assert.deepEqual(c.shown.permissions.filter((p) => p.feature != null), [
      { feature: 'selfAudit', setting: 'forbidden', mandatory: true, currentlyGranted: true },
      { feature: 'selfRevoke', setting: 'forbidden', mandatory: true, currentlyGranted: true },
    ]);
    // A client allowed webhooks: a forbid on its grant is the owner's, shown.
    const c2 = composeShownOffer(req, current, { ...CLIENT, allowFeatures: ['webhooks'] });
    assert.ok(c2.shown.permissions.some((p) => p.feature === 'webhooks' && p.mandatory === true));
  });

  it('[OCMPU5] the subject change is flagged in both directions and bound by the digest', () => {
    const pseudoToAccount = composeShownOffer(requested([{ streamId: 'a', level: 'read' }]), { aliased: true, permissions: [] }, CLIENT);
    assert.deepEqual(pseudoToAccount.subjectChange, { from: 'pseudonym', to: 'account' });
    const accountToPseudo = composeShownOffer(requested([{ streamId: 'a', level: 'read' }], { randomAlias: true }), { aliased: false, permissions: [] }, CLIENT);
    assert.deepEqual(accountToPseudo.subjectChange, { from: 'account', to: 'pseudonym' });
    const same = composeShownOffer(requested([{ streamId: 'a', level: 'read' }]), { aliased: false, permissions: [] }, CLIENT);
    assert.equal(same.subjectChange, null);
    assert.notEqual(same.shownDigest, pseudoToAccount.shownDigest);
  });

  it('[OCMPU6] determinism: same inputs, same digest; the request\'s entry order does not count', () => {
    const current = { aliased: false, permissions: [{ streamId: 'x', level: 'read' }] };
    const one = composeShownOffer(requested([{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'contribute' }, { feature: 'webhooks', setting: 'forbidden' }]), current, CLIENT);
    const again = composeShownOffer(requested([{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'contribute' }, { feature: 'webhooks', setting: 'forbidden' }]), current, CLIENT);
    const permuted = composeShownOffer(requested([{ feature: 'webhooks', setting: 'forbidden' }, { streamId: 'b', level: 'contribute' }, { streamId: 'a', level: 'read' }]), current, CLIENT);
    assert.equal(one.shownDigest, again.shownDigest);
    assert.equal(one.shownDigest, permuted.shownDigest);
    // Another offer digest, another screen digest.
    assert.notEqual(shownDigestOf('other', one.shown, null), one.shownDigest);
    // Another grant, another screen.
    const other = composeShownOffer(requested([{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'contribute' }, { feature: 'webhooks', setting: 'forbidden' }]), { aliased: false, permissions: [] }, CLIENT);
    assert.notEqual(other.shownDigest, one.shownDigest);
    // Same shown levels, another level held: another screen (currentLevel is bound).
    const heldRead = composeShownOffer(requested([{ streamId: 'a', level: 'contribute' }]), { aliased: false, permissions: [{ streamId: 'a', level: 'read' }] }, CLIENT);
    const heldContribute = composeShownOffer(requested([{ streamId: 'a', level: 'contribute' }]), { aliased: false, permissions: [{ streamId: 'a', level: 'contribute' }] }, CLIENT);
    assert.equal(heldRead.shown.permissions[0].level, heldContribute.shown.permissions[0].level);
    assert.notEqual(heldRead.shownDigest, heldContribute.shownDigest);
  });

  it('[OCMPU8] the display annotations of a shown entry are dropped from a granted entry', () => {
    assert.deepEqual(normalizePermissions([{ streamId: 'a', level: 'contribute', currentlyGranted: true, currentLevel: 'read' }]),
      [{ streamId: 'a', level: 'contribute' }]);
  });

  it('[OCMPU7] the grant after a consent: replace exactly, union, sticky restrictions, default forbids', () => {
    const current = { aliased: false, permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'contribute' }, { streamId: 'm', level: 'none' }, { feature: 'selfAudit', setting: 'forbidden' }] };
    const granted = [{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'allowed' }];
    const replace = nextGrantPermissions({ granted, current, client: CLIENT, replace: true });
    assert.deepEqual(replace, [
      { streamId: 'a', level: 'read' },
      { feature: 'webhooks', setting: 'forbidden' },
      { streamId: 'm', level: 'none' },
      { feature: 'selfAudit', setting: 'forbidden' },
      { feature: 'secretSharing', setting: 'forbidden' },
    ]);
    const union = nextGrantPermissions({ granted, current, client: CLIENT, replace: false });
    assert.deepEqual(union.filter((p) => p.streamId != null).map((p) => p.streamId + ':' + p.level).sort(), ['a:read', 'b:contribute', 'm:none']);
    // Allowed on the row: no default forbid for that feature.
    const allowed = nextGrantPermissions({ granted, current: null, client: { ...CLIENT, allowFeatures: ['webhooks', 'secretSharing'] }, replace: true });
    assert.deepEqual(allowed, [{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'allowed' }]);
    // Idempotent: applying the defaults again changes nothing.
    const twice = nextGrantPermissions({ granted: replace, current: null, client: CLIENT, replace: true });
    assert.deepEqual(new Set(twice.map((p) => JSON.stringify(p))), new Set(replace.map((p) => JSON.stringify(p))));
    assert.equal(twice.length, replace.length);
  });
});

describe('[OFBD] forbidden features in consent context', () => {
  afterEach(() => extension._resetForTests());

  it('[OFBD1] a forbid is forced mandatory; with optIn it is refused', () => {
    assert.deepEqual(normalizePermissions([{ feature: 'webhooks', setting: 'forbidden' }], { consent: true }),
      [{ feature: 'webhooks', setting: 'forbidden', mandatory: true }]);
    assert.throws(() => normalizePermissions([{ feature: 'webhooks', setting: 'forbidden', optIn: true }], { consent: true }), /optIn/);
    // Outside consent context nothing changes.
    assert.deepEqual(normalizePermissions([{ feature: 'webhooks', setting: 'forbidden' }]), [{ feature: 'webhooks', setting: 'forbidden' }]);
  });

  it('[OFBD2] a forbid dropped under allowUserChoice: mandatory-refused', () => {
    const offered = normalizePermissions([{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'forbidden' }], { consent: true });
    const r = checkConsentGrant([{ streamId: 'a', level: 'read' }], offered, true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mandatory-refused');
  });

  it('[OFBD3] grammar forbids pass the parse, the maximum set (without listing them) and the digest', () => {
    extension.setExtension({
      apiVersion: 1,
      name: 'forbids',
      scopeGrammar: {
        parse (s) {
          const tokens = s.split(/\s+/).filter((t) => t !== '');
          return {
            ok: true,
            tokens,
            offer: {
              permissions: [{ streamId: 'a', level: 'read' },
                ...(tokens.includes('locked') ? [{ feature: 'secretSharing', setting: 'forbidden', mandatory: true }, { feature: 'webhooks', setting: 'forbidden', mandatory: true }] : [])],
            },
          };
        },
        echo: ({ requestedTokens }) => requestedTokens,
      },
    });
    scopeGrammar._resetForTests();
    const client = { ...CLIENT, scope: ['read'], grantTypes: ['authorization_code'] };
    const r = scopeGrammar.resolveRequestedScope(client, 'read locked');
    assert.equal(r.ok, true, r.description);
    assert.equal(r.offer.permissions.filter((p) => p.setting === 'forbidden' && p.mandatory === true).length, 2);
    const plain = scopeGrammar.resolveRequestedScope(client, 'read');
    assert.notEqual(plain.digest, r.digest);
    const c = composeShownOffer(r, null, client);
    const check = checkConsentGrant(normalizePermissions(c.shown.permissions), normalizePermissions(c.shown.permissions, { consent: true }), false);
    assert.equal(check.ok, true);
  });
});
