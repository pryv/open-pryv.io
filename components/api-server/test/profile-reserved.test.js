/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Server-managed security state in the private profile (the MFA enrolment
 * `mfa` and the failed-attempt tally `mfaThrottle`) is neither returned by nor
 * writable through the profile methods, and an app access whose name is a
 * non-app profile id ("private", "public") cannot reach those profiles.
 */

const ErrorIds = require('errors').ErrorIds;
const storage = require('storage');

describe('[PRSV] profile: reserved state and reserved ids', function () {
  let username;
  let personalToken;
  let privateAppToken;
  let publicAppToken;
  let user;
  const MFA = { method: 'totp', totp: { secret: 'enc-envelope', lastUsedStep: 7 }, recoveryCodes: ['h1'] };
  const THROTTLE = { failures: 2, lastFailureAt: 1, notBefore: 0 };

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    privateAppToken = cuid();
    publicAppToken = cuid();
    user = await fixtures.user(username);
    await user.access({ type: 'personal', token: personalToken });
    await user.session(personalToken);
    await user.access({ type: 'app', name: 'private', token: privateAppToken, permissions: [{ streamId: '*', level: 'read' }] });
    await user.access({ type: 'app', name: 'public', token: publicAppToken, permissions: [{ streamId: '*', level: 'read' }] });
    await fixtures.context.profile(username, {
      id: 'private',
      data: { language: 'fr', mfa: MFA, mfaThrottle: THROTTLE }
    });
  });

  async function storedPrivate () {
    const profile = (await storage.getStorageLayer()).profile;
    const item = await new Promise((resolve, reject) =>
      profile.findOne({ id: user.attrs.id, username }, { id: 'private' }, null, (err, res) => err ? reject(err) : resolve(res)));
    return item.data;
  }

  it('[PRS1] GET /profile/private omits mfa and mfaThrottle, and keeps the rest', async function () {
    const res = await coreRequest.get(`/${username}/profile/private`).set('Authorization', personalToken);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.profile.language, 'fr');
    assert.strictEqual(res.body.profile.mfa, undefined);
    assert.strictEqual(res.body.profile.mfaThrottle, undefined);
  });

  it('[PRS2] PUT /profile/private refuses mfa and mfaThrottle and leaves them untouched', async function () {
    for (const update of [{ mfa: null }, { mfaThrottle: null }, { mfa: { method: 'sms' }, language: 'de' }]) {
      const res = await coreRequest.put(`/${username}/profile/private`).set('Authorization', personalToken).send(update);
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
    }
    const data = await storedPrivate();
    assert.deepStrictEqual(data.mfa, MFA);
    assert.deepStrictEqual(data.mfaThrottle, THROTTLE);
    assert.strictEqual(data.language, 'fr', 'a refused update writes nothing');
  });

  it('[PRS3] other private keys still update, the reserved state survives, and is not echoed', async function () {
    const res = await coreRequest.put(`/${username}/profile/private`).set('Authorization', personalToken).send({ language: 'it' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.profile.language, 'it');
    assert.strictEqual(res.body.profile.mfa, undefined);
    const data = await storedPrivate();
    assert.deepStrictEqual(data.mfa, MFA);
    assert.deepStrictEqual(data.mfaThrottle, THROTTLE);
  });

  it('[PRS4] an app access named "private" or "public" reaches no profile through /profile/app', async function () {
    for (const token of [privateAppToken, publicAppToken]) {
      const get = await coreRequest.get(`/${username}/profile/app`).set('Authorization', token);
      assert.strictEqual(get.status, 400, JSON.stringify(get.body));
      assert.strictEqual(get.body.error.id, ErrorIds.InvalidOperation);
      const put = await coreRequest.put(`/${username}/profile/app`).set('Authorization', token).send({ language: 'xx' });
      assert.strictEqual(put.status, 400, JSON.stringify(put.body));
    }
    assert.strictEqual((await storedPrivate()).language, 'it', 'the private profile was not written through /profile/app');
  });
});
