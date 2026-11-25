/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// A personal token updating its own CMC event (here a consent offer) is
// judged as its create would be, on the merged event, when the update changes
// the content; an update that leaves the content as it is is not judged.
describe('[CMUV] events.update of a CMC event by a personal token', function () {
  this.timeout(60_000);

  let username, token, fixtures;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'cmuv-' + cuid().slice(-8);
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const scope = await coreRequest.post('/' + username + '/streams').set('Authorization', token)
      .send({ id: ':_cmc:apps:cmuv-app', name: 'cmuv-app', parentId: ':_cmc:apps' });
    assert.strictEqual(scope.status, 201, scope.text);
  });

  after(async function () {
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  const offer = (permissions, title = 'Study') => ({
    to: null,
    capabilityRequested: true,
    request: { title: { en: title }, description: { en: 'D' }, consent: { en: 'I agree' }, permissions },
  });
  const VALID = [{ streamId: 'diary', level: 'read' }];
  const TYPO = [...VALID, { feature: 'webhook', setting: 'forbidden' }];

  async function createOffer () {
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', token)
      .send({ streamIds: [':_cmc:apps:cmuv-app'], type: 'consent/request-cmc', content: offer(VALID) });
    assert.strictEqual(res.status, 201, res.text);
    return res.body.event;
  }

  function update (id, update) {
    return coreRequest.put('/' + username + '/events/' + id).set('Authorization', token).send(update);
  }

  it('[CMUV2] a content update adding an unknown feature permission is refused; the stored offer is unchanged', async function () {
    const event = await createOffer();
    const res = await update(event.id, { content: offer(TYPO) });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error.data?.id, 'cmc-invalid-event-content', res.text);
    assert.ok(res.body.error.data.errors.some((e) => e.includes('unknown feature \'webhook\'')), res.text);
    const stored = await coreRequest.get('/' + username + '/events/' + event.id).set('Authorization', token);
    assert.deepStrictEqual(stored.body.event.content.request.permissions, VALID);
  });

  it('[CMUV3] an update that leaves the content as it is still works; a valid content change too', async function () {
    const event = await createOffer();
    const described = await update(event.id, { description: 'note' });
    assert.strictEqual(described.status, 200, described.text);
    const read = await coreRequest.get('/' + username + '/events/' + event.id).set('Authorization', token);
    const echoed = await update(event.id, { content: read.body.event.content });
    assert.strictEqual(echoed.status, 200, echoed.text);
    const retitled = await update(event.id, { content: { ...read.body.event.content, request: { ...read.body.event.content.request, title: { en: 'Renamed' } } } });
    assert.strictEqual(retitled.status, 200, retitled.text);
    assert.strictEqual(retitled.body.event.content.request.title.en, 'Renamed');
  });
});
