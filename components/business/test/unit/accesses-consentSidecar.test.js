/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the auth-request `consent` sidecar resolver.
 */

const assert = require('node:assert/strict');

const { resolveConsentSidecar, ConsentSidecarError } =
  require('../../src/accesses/consentSidecar.ts');

const PERMS = [
  { streamId: 'diary', level: 'read', defaultName: 'Journal' },
  { streamId: 'weight', level: 'read' },
  { feature: 'selfRevoke', setting: 'forbidden' },
];

describe('[CSID] auth-request consent sidecar', () => {
  describe('[CSID-OK] resolution', () => {
    it('[CS01] annotates by id and keeps every other field of the entry', () => {
      const form = resolveConsentSidecar(PERMS, {
        allowUserChoice: true,
        mandatory: ['diary'],
        optIn: ['weight', 'selfRevoke'],
      });
      assert.deepEqual(form, {
        allowUserChoice: true,
        permissions: [
          { streamId: 'diary', level: 'read', defaultName: 'Journal', mandatory: true },
          { streamId: 'weight', level: 'read', optIn: true },
          { feature: 'selfRevoke', setting: 'forbidden', optIn: true },
        ],
      });
    });

    it('[CS02] an empty sidecar is valid: no annotation, all-or-nothing', () => {
      const form = resolveConsentSidecar(PERMS, {});
      assert.equal(form.allowUserChoice, false);
      assert.deepEqual(form.permissions, [
        { streamId: 'diary', level: 'read', defaultName: 'Journal' },
        { streamId: 'weight', level: 'read' },
        { feature: 'selfRevoke', setting: 'forbidden' },
      ]);
    });

    it('[CS03] the sidecar is the only source of annotations', () => {
      // An annotation written inside an entry is dropped, so the echoed
      // requestedPermissions stay exactly what the app sent and cannot
      // contradict the sidecar.
      const form = resolveConsentSidecar(
        [{ streamId: 'diary', level: 'read', mandatory: true }, { streamId: 'weight', level: 'read' }],
        { optIn: ['diary'] }
      );
      assert.deepEqual(form.permissions, [
        { streamId: 'diary', level: 'read', optIn: true },
        { streamId: 'weight', level: 'read' },
      ]);
    });

    it('[CS04] mandatory ids without allowUserChoice are accepted and inert', () => {
      // Same as a CMC offer: all-or-nothing already implies every entry is
      // required, so the annotation changes nothing. Refusing it would make
      // the two flows disagree for no gain.
      const form = resolveConsentSidecar(PERMS, { mandatory: ['diary'] });
      assert.equal(form.allowUserChoice, false);
      assert.equal(form.permissions[0].mandatory, true);
    });
  });

  describe('[CSID-KO] rejection', () => {
    const rejects = (perms, sidecar, re) =>
      assert.throws(() => resolveConsentSidecar(perms, sidecar),
        (err) => err instanceof ConsentSidecarError && re.test(err.message));

    it('[CS05] the sidecar must be an object', () => {
      rejects(PERMS, [], /consent must be an object/);
      rejects(PERMS, 'yes', /consent must be an object/);
      rejects(PERMS, null, /consent must be an object/);
    });

    it('[CS06] allowUserChoice must be a boolean, the id lists arrays of strings', () => {
      rejects(PERMS, { allowUserChoice: 'true' }, /allowUserChoice must be a boolean/);
      rejects(PERMS, { mandatory: 'diary' }, /consent\.mandatory must be an array/);
      rejects(PERMS, { optIn: [1] }, /consent\.optIn must contain non-empty permission ids/);
      rejects(PERMS, { optIn: [''] }, /consent\.optIn must contain non-empty permission ids/);
    });

    it('[CS07] an id naming no requested entry is a typo, not a no-op', () => {
      rejects(PERMS, { mandatory: ['diarry'] }, /'diarry', which is not among requestedPermissions/);
      rejects(PERMS, { optIn: ['selfDestruct'] }, /'selfDestruct', which is not among requestedPermissions/);
    });

    it('[CS08] an id matching two requested entries is ambiguous', () => {
      rejects(
        [{ streamId: 'diary', level: 'read' }, { streamId: 'diary', level: 'contribute' }],
        { mandatory: ['diary'] },
        /matches 2 requested permissions/
      );
    });

    it('[CS09] an id in both lists contradicts', () => {
      rejects(PERMS, { mandatory: ['diary'], optIn: ['diary'] },
        /both mandatory and optIn, which contradict/);
    });

    it('[CS10] the exclusion-mask guard applies on this path too', () => {
      // A `level: 'none'` entry masks a broader grant, so dropping it at
      // the consent screen would WIDEN access. Refused as soon as a consent
      // form is asked for, exactly as in a CMC or OAuth2 offer.
      rejects(
        [{ streamId: '*', level: 'read' }, { streamId: 'medical', level: 'none' }],
        { allowUserChoice: true },
        /level 'none'.*not allowed in a consent offer/
      );
    });

    it('[CS11] a malformed permission entry is reported, not coerced', () => {
      rejects([{ streamId: 'diary', level: 'root' }], {}, /invalid permission at index 0/);
      rejects('not-an-array', {}, /permissions must be an array/);
    });
  });
});
