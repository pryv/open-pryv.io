/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the permission-set lexicon single point.
 */

const assert = require('node:assert/strict');

const ps = require('../../src/accesses/permissionSet.ts');

describe('[PSET] accesses permissionSet', () => {
  describe('[PSET-L] lexicon values', () => {
    it('[PS01] exposes the ordered level map and value lists', () => {
      assert.deepEqual(ps.PermissionLevels, {
        none: -1, read: 0, 'create-only': 1, contribute: 1, manage: 2
      });
      assert.deepEqual([...ps.PERMISSION_LEVEL_VALUES].sort(),
        ['contribute', 'create-only', 'manage', 'none', 'read']);
      assert.deepEqual([...ps.FEATURE_SETTING_VALUES], ['forbidden']);
    });
  });

  describe('[PSET-G] guards', () => {
    it('[PS02] recognizes stream and feature permissions', () => {
      assert.equal(ps.isStreamPermission({ streamId: 'health', level: 'read' }), true);
      assert.equal(ps.isFeaturePermission({ feature: 'selfRevoke', setting: 'forbidden' }), true);
      assert.equal(ps.isStreamPermission({ feature: 'selfRevoke', setting: 'forbidden' }), false);
      assert.equal(ps.isFeaturePermission({ streamId: 'health', level: 'read' }), false);
      assert.equal(ps.isStreamPermission({ streamId: 'health', level: 'root' }), false);
      assert.equal(ps.isFeaturePermission({ feature: 'selfRevoke', setting: 'maybe' }), false);
      assert.equal(ps.isStreamPermission(null), false);
      assert.equal(ps.isFeaturePermission('selfRevoke'), false);
    });
  });

  describe('[PSET-N] normalizePermissions', () => {
    it('[PS03] passes the full lexicon through, preserving display names', () => {
      const input = [
        { streamId: 'health', level: 'contribute', defaultName: 'Health', junk: true },
        { feature: 'selfRevoke', setting: 'forbidden' },
        { streamId: 'diary', level: 'create-only', name: 'Diary' }
      ];
      const out = ps.normalizePermissions(input);
      assert.deepEqual(out, [
        { streamId: 'health', level: 'contribute', defaultName: 'Health' },
        { feature: 'selfRevoke', setting: 'forbidden' },
        { streamId: 'diary', level: 'create-only', name: 'Diary' }
      ]);
    });

    it('[PS04] rejects invalid entries with the offending index', () => {
      assert.throws(() => ps.normalizePermissions('nope'), /must be an array/);
      assert.throws(() => ps.normalizePermissions([{ streamId: 'a', level: 'root' }]), /index 0/);
      assert.throws(() => ps.normalizePermissions([
        { streamId: 'a', level: 'read' },
        { feature: 'selfRevoke' }
      ]), /index 1/);
    });
  });

  describe('[PSET-S] isPermissionSubset', () => {
    const offered = [
      { streamId: 'health', level: 'read' },
      { streamId: 'diary', level: 'contribute' },
      { feature: 'selfRevoke', setting: 'forbidden' }
    ];

    it('[PS05] accepts identical and reduced sets, ignoring display names', () => {
      assert.deepEqual(ps.isPermissionSubset(offered, offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset(
        [{ streamId: 'health', level: 'read', defaultName: 'Health' }], offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset([], offered), { ok: true });
      assert.deepEqual(ps.isPermissionSubset(
        [{ feature: 'selfRevoke', setting: 'forbidden' }], offered), { ok: true });
    });

    it('[PS06] rejects widened or altered entries and reports them', () => {
      const r1 = ps.isPermissionSubset([{ streamId: 'health', level: 'manage' }], offered);
      assert.equal(r1.ok, false);
      assert.deepEqual(r1.offending, [{ streamId: 'health', level: 'manage' }]);
      const r2 = ps.isPermissionSubset([{ streamId: 'other', level: 'read' }], offered);
      assert.equal(r2.ok, false);
      const r3 = ps.isPermissionSubset([{ feature: 'selfAudit', setting: 'forbidden' }], offered);
      assert.equal(r3.ok, false);
    });
  });

  describe('[PSET-C] consent annotations + checkConsentGrant', () => {
    const offered = [
      { streamId: 'health', level: 'read', mandatory: true },
      { streamId: 'diary', level: 'contribute' },
      { feature: 'selfRevoke', setting: 'forbidden', mandatory: true },
    ];
    const consentOffered = ps.normalizePermissions(offered, { consent: true });

    it('[PS07] consent form preserves mandatory; plain form and strip drop it', () => {
      assert.deepEqual(consentOffered, offered);
      assert.deepEqual(ps.normalizePermissions(offered), [
        { streamId: 'health', level: 'read' },
        { streamId: 'diary', level: 'contribute' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ]);
      assert.deepEqual(ps.stripConsentAnnotations(consentOffered),
        ps.normalizePermissions(offered));
    });

    it('[PS08] default (no user choice) is ALL OR NOTHING', () => {
      const full = ps.normalizePermissions(offered);
      assert.deepEqual(ps.checkConsentGrant(full, consentOffered, false), { ok: true });
      const partial = [{ streamId: 'health', level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden' }];
      const r = ps.checkConsentGrant(partial, consentOffered, false);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'choice-not-allowed');
      assert.deepEqual(r.offending, [{ streamId: 'diary', level: 'contribute' }]);
    });

    it('[PS09] with user choice, optional entries may be dropped but mandatory ones may not', () => {
      const keptMandatoryOnly = [
        { streamId: 'health', level: 'read' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ];
      assert.deepEqual(ps.checkConsentGrant(keptMandatoryOnly, consentOffered, true), { ok: true });
      const droppedMandatory = [{ streamId: 'diary', level: 'contribute' }];
      const r = ps.checkConsentGrant(droppedMandatory, consentOffered, true);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'mandatory-refused');
      assert.deepEqual(r.offending, [
        { streamId: 'health', level: 'read' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ]);
    });

    it('[PS10] granted outside the offer is not-subset regardless of the choice flag', () => {
      for (const allow of [false, true]) {
        const r = ps.checkConsentGrant([{ streamId: 'other', level: 'read' }], consentOffered, allow);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'not-subset');
      }
    });
  });

  describe('[PSET-MASK] consent offers reject exclusion masks (level:none)', () => {
    // `none` is an EXCLUSION MASK in AccessLogic (cannot-list / forbidden-get),
    // so an offered `none` masking a broader grant inverts the consent subset
    // rule: dropping it WIDENS access. Offers must therefore not carry masks.
    it('[PS-MASK1] a consent offer containing a level:none entry is rejected', () => {
      assert.throws(
        () => ps.normalizePermissions(
          [{ streamId: 'health', level: 'read' }, { streamId: 'medical-private', level: 'none' }],
          { consent: true }
        ),
        /level 'none'.*not allowed in a consent offer/
      );
    });

    it('[PS-MASK2] the exact review exploit (broad read + masked-out stream) cannot be offered', () => {
      // Offer: read everything EXCEPT medical-private; drop the mask → read it.
      // Rejected at offer normalization, so the accept flow never builds it.
      assert.throws(
        () => ps.normalizePermissions(
          [{ streamId: '*', level: 'read', mandatory: true }, { streamId: 'medical-private', level: 'none' }],
          { consent: true }
        ),
        /not allowed in a consent offer/
      );
    });

    it('[PS-MASK3] a granted level:none can never pass — offered can no longer carry it, so subset fails', () => {
      // Even if a caller forges a granted `none`, there is no offered twin
      // (offers reject none), so the subset check rejects it.
      const offered = ps.normalizePermissions(
        [{ streamId: 'health', level: 'read' }, { streamId: 'diary', level: 'contribute' }],
        { consent: true }
      );
      for (const allow of [false, true]) {
        const r = ps.checkConsentGrant([{ streamId: 'health', level: 'none' }], offered, allow);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'not-subset');
      }
    });

    it('[PS-MASK4] positive-only offers (read/contribute/create-only/manage/feature) still normalize fine', () => {
      const ok = ps.normalizePermissions(
        [
          { streamId: 'a', level: 'read' },
          { streamId: 'b', level: 'contribute' },
          { streamId: 'c', level: 'create-only' },
          { streamId: 'd', level: 'manage' },
          { feature: 'selfRevoke', setting: 'forbidden' },
        ],
        { consent: true }
      );
      assert.equal(ok.length, 5);
    });

    it('[PS-MASK5] level:none is still valid OUTSIDE consent (normal accesses.create masks)', () => {
      // The mask semantics are legitimate for a directly-created access;
      // the restriction is consent-offer-scoped only.
      const out = ps.normalizePermissions([{ streamId: 'x', level: 'none' }]);
      assert.deepEqual(out, [{ streamId: 'x', level: 'none' }]);
    });
  });

  describe('[PSET-CAP] level → capability mapping (matches AccessLogic)', () => {
    it('[PS-CAP1] capabilitiesForLevel matches AccessLogic predicates exactly', () => {
      assert.deepEqual(ps.capabilitiesForLevel('read'),
        { read: true, create: false, update: false, manage: false, list: true });
      // create-only: creatable + listable, but NOT readable and NOT updatable
      // — the asymmetry a numeric-rank test misses.
      assert.deepEqual(ps.capabilitiesForLevel('create-only'),
        { read: false, create: true, update: false, manage: false, list: true });
      assert.deepEqual(ps.capabilitiesForLevel('contribute'),
        { read: true, create: true, update: true, manage: false, list: true });
      assert.deepEqual(ps.capabilitiesForLevel('manage'),
        { read: true, create: true, update: true, manage: true, list: true });
    });

    it('[PS-CAP2] none / null / undefined / unknown confer nothing', () => {
      const nothing = { read: false, create: false, update: false, manage: false, list: false };
      assert.deepEqual(ps.capabilitiesForLevel('none'), nothing);
      assert.deepEqual(ps.capabilitiesForLevel(null), nothing);
      assert.deepEqual(ps.capabilitiesForLevel(undefined), nothing);
      assert.deepEqual(ps.capabilitiesForLevel('bogus'), nothing);
    });

    it('[PS-CAP3] levelCapabilityExcess flags where granted exceeds offered', () => {
      // manage vs read (the {*,manage}+{secret,read} → drop-secret case):
      // granted gains create/update/manage that offered (read) never had.
      assert.deepEqual(ps.levelCapabilityExcess('manage', 'read').sort(),
        ['create', 'manage', 'update']);
      // read vs create-only (the {*,read}+{X,create-only} → drop-X case):
      // granted gains READ that create-only masked.
      assert.deepEqual(ps.levelCapabilityExcess('read', 'create-only'), ['read']);
    });

    it('[PS-CAP4] levelCapabilityExcess is empty when granted ⊆ offered effectively', () => {
      assert.deepEqual(ps.levelCapabilityExcess('read', 'read'), []);
      assert.deepEqual(ps.levelCapabilityExcess('read', 'manage'), []); // narrower
      assert.deepEqual(ps.levelCapabilityExcess('create-only', 'contribute'), []); // contribute ⊇ create-only
      assert.deepEqual(ps.levelCapabilityExcess('none', 'read'), []); // grants nothing
      assert.deepEqual(ps.levelCapabilityExcess(undefined, 'read'), []); // no grant at all
    });

    it('[PS-CAP5] create-only vs read is a MUTUAL mask (each grants what the other forbids)', () => {
      // create-only adds create; read adds read. Neither ⊆ the other.
      assert.deepEqual(ps.levelCapabilityExcess('create-only', 'read'), ['create']);
      assert.deepEqual(ps.levelCapabilityExcess('read', 'create-only'), ['read']);
    });
  });
});
