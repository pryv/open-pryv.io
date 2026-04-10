/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;

const { createMFAService, ChallengeVerifyService, SingleService } = require('../../../src/mfa');

const baseConfig = {
  sms: {
    endpoints: {
      challenge: { url: '', method: 'POST', body: '', headers: {} },
      verify: { url: '', method: 'POST', body: '', headers: {} },
      single: { url: '', method: 'POST', body: '', headers: {} }
    }
  },
  sessions: { ttlSeconds: 1800 }
};

describe('[MFAF] mfa/createMFAService factory', () => {
  it('[MF1A] returns null when mode is disabled', () => {
    assert.isNull(createMFAService({ ...baseConfig, mode: 'disabled' }));
  });

  it('[MF1B] returns null when config is missing', () => {
    assert.isNull(createMFAService(null));
    assert.isNull(createMFAService(undefined));
    assert.isNull(createMFAService({ ...baseConfig }));
  });

  it('[MF2A] returns a ChallengeVerifyService for mode=challenge-verify', () => {
    const svc = createMFAService({ ...baseConfig, mode: 'challenge-verify' });
    assert.instanceOf(svc, ChallengeVerifyService);
  });

  it('[MF2B] returns a SingleService for mode=single', () => {
    const svc = createMFAService({ ...baseConfig, mode: 'single' });
    assert.instanceOf(svc, SingleService);
  });

  it('[MF3A] throws on unknown mode', () => {
    assert.throws(
      () => createMFAService({ ...baseConfig, mode: 'totp' }),
      /Unknown MFA mode "totp"/
    );
  });
});
