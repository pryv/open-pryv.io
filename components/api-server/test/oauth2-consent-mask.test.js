/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Consent hierarchical-masking guard — integration against a REAL stream
 * tree + mall (Pattern C, initCore). The unit tests
 * (accesses-consentEffectiveGuard) cover the decision logic with injected
 * resolvers; this proves the production `AccessLogic` resolver actually
 * walks the user's stream hierarchy (parentId ancestry + `'*'` fallback)
 * and catches the widening a pure entry-subset check misses.
 *
 * The exploit shape: an `allowUserChoice` offer mixes a broad ancestor
 * grant with a narrower descendant/sibling entry; unticking the narrower
 * entry (user intends "deny") re-inherits the broader ancestor and WIDENS
 * effective access.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertGrantedWithinOffer } =
  require('business/src/accesses/consentEffectiveGuard.ts');

describe('[OAUTH-MASK] consent hierarchical-masking guard (real tree)', function () {
  this.timeout(60_000);

  let alice; // { username, personalToken, streamsPath }
  const A = 'mask-a-' + cuid().slice(-8); // parent
  const B = 'mask-b-' + cuid().slice(-8); // child of A

  before(async function () {
    await initTests();
    await initCore();
    const fixtures = getNewFixture();
    const username = 'alice-mask-' + cuid().slice(-8);
    const personalToken = cuid();
    const u = await fixtures.user(username);
    await u.access({ token: personalToken, type: 'personal' });
    await u.session(personalToken);
    alice = { username, personalToken, streamsPath: '/' + username + '/streams' };
    // Build the tree: A (root) then B under A.
    await createStream(A, null);
    await createStream(B, A);
  });

  async function createStream (id, parentId) {
    const params = { id, name: id };
    if (parentId != null) params.parentId = parentId;
    const res = await coreRequest.post(alice.streamsPath)
      .set('Authorization', alice.personalToken).send(params);
    if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
      throw new Error('createStream(' + id + ') failed: ' + res.status + ' ' + JSON.stringify(res.body));
    }
  }

  function check (granted, offered) {
    return assertGrantedWithinOffer({ userId: alice.username, granted, offered });
  }

  it('[OAUTH-MASK1] specific ancestor: drop {B,create-only} under {A,read} → WIDENS (B re-inherits read)', async () => {
    const offered = [{ streamId: A, level: 'read' }, { streamId: B, level: 'create-only' }];
    const granted = [{ streamId: A, level: 'read' }]; // user unticked B
    const res = await check(granted, offered);
    assert.equal(res.ok, false, 'dropping a create-only mask under a read ancestor must widen');
    const v = res.violations.find((x) => x.streamId === B);
    assert.ok(v, 'B must be flagged');
    assert.deepEqual(v.excess, ['read']);
  });

  it('[OAUTH-MASK2] `*` fallback: drop {B,read} under {*,manage} → WIDENS (B re-inherits manage)', async () => {
    const offered = [{ streamId: '*', level: 'manage' }, { streamId: B, level: 'read' }];
    const granted = [{ streamId: '*', level: 'manage' }]; // user unticked B
    const res = await check(granted, offered);
    assert.equal(res.ok, false);
    const v = res.violations.find((x) => x.streamId === B);
    assert.ok(v);
    assert.deepEqual(v.excess.sort(), ['create', 'manage', 'update']);
  });

  it('[OAUTH-MASK3] legitimate narrowing: drop {B,manage} under {A,read} → OK (B narrows to inherited read)', async () => {
    const offered = [{ streamId: A, level: 'read' }, { streamId: B, level: 'manage' }];
    const granted = [{ streamId: A, level: 'read' }]; // B narrows from manage to inherited read
    const res = await check(granted, offered);
    assert.equal(res.ok, true, 'dropping a broader descendant is legitimate narrowing');
  });

  it('[OAUTH-MASK4] keep the whole offer → OK (granted == offered, no divergence)', async () => {
    const offered = [{ streamId: A, level: 'read' }, { streamId: B, level: 'create-only' }];
    const res = await check(offered.slice(), offered);
    assert.equal(res.ok, true);
  });
});
