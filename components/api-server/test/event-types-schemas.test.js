/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// Types whose schema the validator could not compile were refused for EVERY
// event, valid or not. These types had such schemas in the catalogue; each must
// now accept valid content and still refuse invalid content. The last test
// guards the whole class: every type the core knows must compile.
describe('[ETSC] event types with repaired schemas', function () {
  this.timeout(30_000);

  let fixtures, username, token;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'etsc-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: 'etsc', name: 'etsc' });
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function create (type, content) {
    return await coreRequest.post('/' + username + '/events')
      .set('Authorization', token)
      .send({ streamIds: ['etsc'], type, content });
  }

  const cases = [
    ['[ETSC1]', 'contact/facebook', { id: '123', name: 'A' }, { name: 'no id' }],
    ['[ETSC2]', 'audiogram/data',
      { sensitivityPoints: [{ frequency: 1000, leftEarSensitivity: 20 }], start: '2026-01-01', end: '2026-01-02' },
      { sensitivityPoints: [{ leftEarSensitivity: 20 }], start: '2026-01-01', end: '2026-01-02' }],
    ['[ETSC3]', 'clinical/fhir',
      { displayName: 'Flu shot', clinicalType: 'immunizationRecord', fhir: { identifier: '1', resourceType: 'immunization' } },
      { clinicalType: 'immunizationRecord' }]
  ];

  for (const [code, type, valid, invalid] of cases) {
    it(`${code} ${type} accepts valid content and refuses invalid content`, async function () {
      const ok = await create(type, valid);
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
      const ko = await create(type, invalid);
      assert.strictEqual(ko.status, 400, JSON.stringify(ko.body));
      assert.strictEqual(ko.body.error.id, 'invalid-parameters-format');
    });
  }

  it('[ETSC4] every type the core knows has a schema its validator compiles', function () {
    const { jsonValidator } = require('utils');
    const seed = require('business/src/types/event-types.default.json');
    const uncompilable = Object.entries(seed.types).filter(([, schema]) => !jsonValidator().validateSchema(schema)).map(([key]) => key);
    assert.deepStrictEqual(uncompilable, []);
  });
});
