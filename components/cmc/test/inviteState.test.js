/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CMCIS] invite state on the `consent/request-cmc` trigger: the transition
 * table, and a stamp that never throws.
 */

const assert = require('node:assert/strict');
const { stampInvite, isTransitionAllowed } = require('../src/inviteState.ts');

function fakeMall (trigger, opts = {}) {
  const events = new Map(trigger != null ? [[trigger.id, trigger]] : []);
  const updates = [];
  return {
    updates,
    get: (id) => events.get(id),
    events: {
      async getOne (userId, id) { return events.get(id) ?? null; },
      async update (userId, event) {
        if (opts.updateThrows) throw new Error('storage down');
        events.set(event.id, event);
        updates.push(event);
        return event;
      },
    },
  };
}

function invite (content) {
  return { id: 'inv-1', type: 'consent/request-cmc', streamIds: [':_cmc:apps:my-app'], content };
}

describe('[CMCIS] cmc/inviteState', () => {
  it('[IS01] pending -> accepted writes the status and fields, and notifies', async () => {
    const mall = fakeMall(invite({ status: 'pending', capabilityId: 'cap-1' }));
    const notified = [];
    const res = await stampInvite({
      userId: 'u1',
      inviteEventId: 'inv-1',
      transition: 'accepted',
      fields: { acceptedBy: { username: 'bob', host: 'b.example.com' }, acceptedAt: 10, backChannelAccessId: 'bc-1' },
      deps: { mall, notifyEventChanged: (u, e) => notified.push(e.id) },
    });
    assert.deepEqual(res, { ok: true, written: true });
    const stored = mall.get('inv-1');
    assert.equal(stored.content.status, 'accepted');
    assert.equal(stored.content.acceptedBy.username, 'bob');
    assert.equal(stored.content.backChannelAccessId, 'bc-1');
    assert.equal(stored.content.capabilityId, 'cap-1', 'existing content is kept');
    assert.deepEqual(stored.streamIds, [':_cmc:apps:my-app'], 'the event is written whole');
    assert.deepEqual(notified, ['inv-1']);
  });

  it('[IS02] an open-link invite refuses accepted / refused / revoked and writes nothing', async () => {
    for (const transition of ['accepted', 'refused', 'revoked']) {
      const mall = fakeMall(invite({ status: 'delivered', capability: { mode: 'open-link' } }));
      const res = await stampInvite({ userId: 'u1', inviteEventId: 'inv-1', transition, deps: { mall } });
      assert.deepEqual(res, { ok: true, written: false, skipped: 'transition-not-allowed' }, transition);
      assert.equal(mall.updates.length, 0);
    }
  });

  it('[IS03] open-link pending -> invalidated writes', async () => {
    const mall = fakeMall(invite({ status: 'delivered', capability: { mode: 'open-link' } }));
    const res = await stampInvite({ userId: 'u1', inviteEventId: 'inv-1', transition: 'invalidated', deps: { mall } });
    assert.equal(res.written, true);
    assert.equal(mall.get('inv-1').content.status, 'invalidated');
  });

  it('[IS04] a final state is not overturned by a late write', async () => {
    const cases = [
      [undefined, 'revoked', 'accepted'],
      [undefined, 'accepted', 'refused'],
      [undefined, 'revoked', 'revoked'],
      ['open-link', 'invalidated', 'invalidated'],
      ['open-link', 'invalidated', 'accepted'],
    ];
    for (const [mode, from, to] of cases) {
      assert.equal(isTransitionAllowed(mode, from, to), false, (mode || 'single-use') + ' ' + from + ' -> ' + to);
    }
    const mall = fakeMall(invite({ status: 'invalidated', capability: { mode: 'open-link' } }));
    const res = await stampInvite({ userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', deps: { mall } });
    assert.equal(res.skipped, 'transition-not-allowed');
    assert.equal(mall.get('inv-1').content.status, 'invalidated');
  });

  it('[IS05] refused -> accepted is allowed: a refusal does not consume a single-use link', async () => {
    assert.equal(isTransitionAllowed(undefined, 'refused', 'accepted'), true);
    const mall = fakeMall(invite({ status: 'refused' }));
    const res = await stampInvite({ userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', deps: { mall } });
    assert.equal(res.written, true);
  });

  it('[IS09] accepting a refused invite drops the refusal fields', async () => {
    const mall = fakeMall(invite({ status: 'refused', refusedBy: { username: 'bob', host: 'b' }, refusedAt: 5, reason: { en: 'no' } }));
    await stampInvite({
      userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', fields: { acceptedBy: { username: 'bob', host: 'b' } }, deps: { mall },
    });
    const c = mall.get('inv-1').content;
    assert.equal(c.status, 'accepted');
    assert.equal('refusedBy' in c, false);
    assert.equal('refusedAt' in c, false);
    assert.equal('reason' in c, false);
  });

  it('[IS06] an event that is not a request, or no event, is skipped', async () => {
    const mall = fakeMall({ id: 'inv-1', type: 'consent/accept-cmc', content: {} });
    assert.equal((await stampInvite({ userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', deps: { mall } })).skipped, 'not-a-request');
    assert.equal((await stampInvite({ userId: 'u1', inviteEventId: 'missing', transition: 'accepted', deps: { mall } })).skipped, 'not-a-request');
    assert.equal((await stampInvite({ userId: 'u1', inviteEventId: null, transition: 'accepted', deps: { mall } })).skipped, 'no-invite-event-id');
    assert.equal(mall.updates.length, 0);
  });

  it('[IS07] a failing write returns ok:false and does not throw', async () => {
    const mall = fakeMall(invite({ status: 'pending' }), { updateThrows: true });
    const warns = [];
    const res = await stampInvite({
      userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', deps: { mall, logger: { warn: (m) => warns.push(m) } },
    });
    assert.deepEqual(res, { ok: false, reason: 'cmc-invite-stamp-failed' });
    assert.equal(warns.length, 1);
  });

  it('[IS08] a mall without events.getOne is skipped without throwing', async () => {
    const res = await stampInvite({
      userId: 'u1', inviteEventId: 'inv-1', transition: 'accepted', deps: { mall: { events: { async update () {} } } },
    });
    assert.deepEqual(res, { ok: true, written: false, skipped: 'mall-events-unavailable' });
  });
});
