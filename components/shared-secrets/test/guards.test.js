/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — streams listing filter.
 *
 * An access sees its own substream of the namespace and no other; a listing
 * made without a known access must not fall back to showing them all.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { filterVisibleStreams } = require('../src/guards.ts');
const { NS } = require('../src/constants.ts');

function tree () {
  return [
    { id: 'diary' },
    {
      id: NS,
      children: [
        { id: NS + 'acc-own' },
        { id: NS + 'acc-other' }
      ]
    }
  ];
}

function ids (streams) {
  const out = [];
  for (const s of streams) {
    out.push(s.id);
    if (Array.isArray(s.children)) out.push(...ids(s.children));
  }
  return out;
}

describe('[SSGF] shared-secrets streams listing filter', () => {
  it('[SSGF1] an app access sees its own substream only', () => {
    const shown = ids(filterVisibleStreams(tree(), { id: 'acc-own', isPersonal: () => false }));
    assert.deepEqual(shown, ['diary', NS, NS + 'acc-own']);
  });

  it('[SSGF2] a personal access sees every substream', () => {
    const shown = ids(filterVisibleStreams(tree(), { id: 'p', isPersonal: () => true }));
    assert.deepEqual(shown, ['diary', NS, NS + 'acc-own', NS + 'acc-other']);
  });

  it('[SSGF3] without a known access no substream is shown', () => {
    for (const access of [null, undefined]) {
      const shown = ids(filterVisibleStreams(tree(), access));
      assert.deepEqual(shown, ['diary', NS]);
    }
  });
});
