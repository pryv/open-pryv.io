/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — counterparty slug helper tests.
 *
 * [CMCSLUG] covers counterpartySlug build / parse round-trip + input
 * validation. There is no separate collector slug — the app and per-request
 * scoping live in the stream PATH, not in the slug.
 */

const assert = require('node:assert/strict');
const slug = require('../src/slug.ts');

describe('[CMCSLUG] cmc/slug', () => {
  describe('[CMCSLUG-CP] counterpartySlug()', () => {
    it('[CS01] composes <username>--<host-with-dashes>', () => {
      assert.equal(
        slug.counterpartySlug({ username: 'bob', host: 'pryv.me' }),
        'bob--pryv-me'
      );
    });

    it('[CS02] lowercases username + host', () => {
      assert.equal(
        slug.counterpartySlug({ username: 'Alice', host: 'Example.COM' }),
        'alice--example-com'
      );
    });

    it('[CS03] multi-dot host gets all dots replaced by hyphens', () => {
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
        () => slug.counterpartySlug({ username: 'bob', host: '' }),
        /host/
      );
    });

    it('[CS06] rejects username containing the double-hyphen separator', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: 'bob--evil', host: 'pryv.me' }),
        /double-hyphen separator/
      );
    });

    it('[CS07] rejects username with disallowed characters', () => {
      assert.throws(
        () => slug.counterpartySlug({ username: 'bob_smith', host: 'pryv.me' }),
        /username/
      );
    });
  });

  describe('[CMCSLUG-PRS] parseCounterpartySlug', () => {
    it('[PR01] round-trips username + host-slug', () => {
      const built = slug.counterpartySlug({ username: 'bob', host: 'pryv.me' });
      const parsed = slug.parseCounterpartySlug(built);
      assert.deepEqual(parsed, { username: 'bob', hostSlug: 'pryv-me' });
    });

    it('[PR02] rejects a 3-piece slug', () => {
      assert.throws(
        () => slug.parseCounterpartySlug('a--b--c'),
        /counterparty slug/
      );
    });

    it('[PR03] rejects a piece with disallowed chars', () => {
      assert.throws(
        () => slug.parseCounterpartySlug('Alice--pryv.me'),
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
