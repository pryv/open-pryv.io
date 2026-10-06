/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin: features resolution.
 *
 * [CMCFE] the offer grants each feature unless it sets it to false; the
 * accept may only narrow; the result is always the two booleans.
 */

const assert = require('node:assert/strict');
const { featuresFromOffer, resolveFeatures } = require('../src/features.ts');

const offerContent = (features) => ({ request: features === undefined ? {} : { features } });

describe('[CMCFE] cmc/features', () => {
  it('[FE01] an offer without features grants both', () => {
    for (const content of [offerContent(undefined), offerContent(null), {}, null, undefined, 'x']) {
      assert.deepEqual(featuresFromOffer(content), { chat: true, systemMessaging: true }, JSON.stringify(content));
    }
  });

  it('[FE02] an offer with chat false grants no chat', () => {
    assert.deepEqual(featuresFromOffer(offerContent({ chat: false })), { chat: false, systemMessaging: true });
    assert.deepEqual(featuresFromOffer(offerContent({ systemMessaging: false })), { chat: true, systemMessaging: false });
  });

  it('[FE03] the accept narrows: chat false turns off an offered chat', () => {
    const offered = featuresFromOffer(offerContent({ chat: true }));
    assert.deepEqual(resolveFeatures(offered, { chat: false }), { chat: false, systemMessaging: true });
    assert.deepEqual(resolveFeatures(offered, { systemMessaging: false }), { chat: true, systemMessaging: false });
  });

  it('[FE04] the accept never widens: chat true does not turn on a chat the offer turned off', () => {
    const offered = featuresFromOffer(offerContent({ chat: false, systemMessaging: false }));
    assert.deepEqual(resolveFeatures(offered, { chat: true, systemMessaging: true }), { chat: false, systemMessaging: false });
  });

  it('[FE05] an accept without features gets the offer\'s', () => {
    const offered = featuresFromOffer(offerContent({ chat: false }));
    for (const requested of [null, undefined, {}, 'yes', []]) {
      assert.deepEqual(resolveFeatures(offered, requested), { chat: false, systemMessaging: true }, JSON.stringify(requested));
    }
  });

  it('[FE06] unknown keys are dropped and the result is always two booleans', () => {
    const offered = featuresFromOffer(offerContent({ chat: 'no', video: true }));
    assert.deepEqual(offered, { chat: true, systemMessaging: true });
    const r = resolveFeatures(offered, { chat: true, video: true, systemMessaging: 0 });
    assert.deepEqual(r, { chat: true, systemMessaging: true });
    assert.deepEqual(Object.keys(r).sort(), ['chat', 'systemMessaging']);
  });
});
