/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 Phase C — slug helpers unit tests.
 *
 * [CMCSLUG] suite covers counterpartySlug / collectorSlug round-trip,
 * input validation, and edge cases (multi-dot hosts, app-id slashes, etc.).
 */

const assert = require('node:assert/strict');
const slug = require('../../src/cmc/slug.ts');

describe('[CMCSLUG] cmc/slug', () => {
  describe('[CMCSLUG-CP] counterpartySlug()', () => {
    it('[CS01] composes <username>--<host-with-dashes>', () => {
      assert.equal(
        slug.counterpartySlug({ username: 'jane', host: 'pryv.me' }),
        'jane--pryv-me'
      );
    });

    it('[CS02] lowercases username + host', () => {
      assert.equal(
        slug.counterpartySlug({ username: 'Dr-Smith', host: 'DataSafe.DEV' }),
        'dr-smith--datasafe-dev'
      );
    });

    it('[CS03] multi-dot host gets all dots replaced by single hyphens', () => {
      assert.equal(
        slug.counterpartySlug({ username: 'bob', host: 'my-host.example.org' }),
        'bob--my-host-example-org'
      );
    });

    it('[CS04] rejects empty username', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: '', host: 'pryv.me' }),
        /username/
      );
    });

    it('[CS05] rejects empty host', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: 'jane', host: '' }),
        /host/
      );
    });

    it('[CS06] rejects username containing the double-hyphen separator', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: 'jane--evil', host: 'pryv.me' }),
        /double-hyphen separator/
      );
    });

    it('[CS07] rejects username with disallowed characters (uppercase resolved by lowercasing; underscores rejected)', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: 'jane_smith', host: 'pryv.me' }),
        /username/
      );
    });
  });

  describe('[CMCSLUG-CL] collectorSlug()', () => {
    it('[CL01] composes <counterparty>--<app-slug>', () => {
      assert.equal(
        slug.collectorSlug({
          username: 'dr-smith',
          host: 'datasafe.dev',
          appId: 'stormm-doctor-dashboard',
        }),
        'dr-smith--datasafe-dev--stormm-doctor-dashboard'
      );
    });

    it('[CL02] slugifies appId dots to single hyphens', () => {
      assert.equal(
        slug.collectorSlug({ username: 'jane', host: 'pryv.me', appId: 'fitness.app' }),
        'jane--pryv-me--fitness-app'
      );
    });

    it('[CL03] slugifies appId slashes to hyphens and collapses runs', () => {
      assert.equal(
        slug.collectorSlug({
          username: 'research-coord',
          host: 'university.edu',
          appId: 'study/v2',
        }),
        'research-coord--university-edu--study-v2'
      );
    });

    it('[CL04] collapses accidental double-hyphens in the appId so the slug remains parseable', () => {
      // `my--app` would otherwise inject a fake separator. Slugifier collapses.
      assert.equal(
        slug.collectorSlug({ username: 'a', host: 'b.c', appId: 'my--app' }),
        'a--b-c--my-app'
      );
    });

    it('[CL05] rejects empty appId', () => {
      assert.throws(
        () => slug.collectorSlug({ username: 'jane', host: 'pryv.me', appId: '' }),
        /appId/
      );
    });
  });

  describe('[CMCSLUG-PRS] parse*()', () => {
    it('[PR01] parseCounterpartySlug round-trips username + host-slug', () => {
      const built = slug.counterpartySlug({ username: 'jane', host: 'pryv.me' });
      const parsed = slug.parseCounterpartySlug(built);
      assert.deepEqual(parsed, { username: 'jane', hostSlug: 'pryv-me' });
    });

    it('[PR02] parseCollectorSlug round-trips username + host-slug + app-slug', () => {
      const built = slug.collectorSlug({
        username: 'dr-smith',
        host: 'datasafe.dev',
        appId: 'stormm-doctor-dashboard',
      });
      const parsed = slug.parseCollectorSlug(built);
      assert.deepEqual(parsed, {
        username: 'dr-smith',
        hostSlug: 'datasafe-dev',
        appSlug: 'stormm-doctor-dashboard',
      });
    });

    it('[PR03] parseCounterpartySlug rejects a 3-piece slug', () => {
      assert.throws(
        () => slug.parseCounterpartySlug('a--b--c'),
        /counterparty slug/
      );
    });

    it('[PR04] parseCollectorSlug rejects a 2-piece slug', () => {
      assert.throws(() => slug.parseCollectorSlug('a--b'), /collector slug/);
    });

    it('[PR05] parseCounterpartySlug rejects a piece with disallowed chars', () => {
      assert.throws(
        () => slug.parseCounterpartySlug('Jane--pryv.me'),
        /slug piece/
      );
    });
  });

  describe('[CMCSLUG-UH] unslugifyHostHint (lossy fallback)', () => {
    it('[UH01] replaces hyphens with dots (display hint only)', () => {
      assert.equal(slug.unslugifyHostHint('pryv-me'), 'pryv.me');
    });
  });
});
