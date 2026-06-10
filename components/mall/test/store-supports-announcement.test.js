/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');

const { MallUserStreams } = require('../src/MallUserStreams.ts');

describe('[CQSA] Store supports announcement on root pseudo-streams', () => {
  const SUPPORTS = { contentQueries: { fields: ['content'], operators: ['eq', 'in'] } };

  const localStore = { streams: { get: async () => [], getOne: async () => null } };
  const declaringStore = {
    streams: { get: async () => [], getOne: async () => null },
    supports () { return SUPPORTS; }
  };
  const silentStore = { streams: { get: async () => [], getOne: async () => null } };

  function makeMallUserStreams () {
    const storesById = new Map([
      ['local', localStore],
      ['ext', declaringStore],
      ['mute', silentStore]
    ]);
    const storeDescriptionsByStore = new Map([
      [localStore, { name: 'Local' }],
      [declaringStore, { name: 'External' }],
      [silentStore, { name: 'Mute' }]
    ]);
    return new MallUserStreams({ storesById, storeDescriptionsByStore });
  }

  it('[SA01] announces supports in clientData of a declaring store\'s root stream', async () => {
    const mus = makeMallUserStreams();
    const res = await mus.get('u1', { id: '*' });
    const extRoot = res.find((s) => s.id === ':ext:');
    assert.ok(extRoot, 'expected :ext: root pseudo-stream');
    assert.deepStrictEqual(extRoot.clientData, { 'pryv-datastore:supports': SUPPORTS });
  });

  it('[SA02] omits clientData for stores announcing nothing', async () => {
    const mus = makeMallUserStreams();
    const res = await mus.get('u1', { id: '*' });
    const muteRoot = res.find((s) => s.id === ':mute:');
    assert.ok(muteRoot, 'expected :mute: root pseudo-stream');
    assert.strictEqual(muteRoot.clientData, undefined);
  });

  it('[SA03] announces on the single-store root form too', async () => {
    const mus = makeMallUserStreams();
    const root = await mus.getOneWithNoChildren('u1', '*', 'ext');
    assert.deepStrictEqual(root.clientData, { 'pryv-datastore:supports': SUPPORTS });
  });
});
