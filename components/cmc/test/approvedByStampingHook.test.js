/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [APB] `content.approvedBy` on a consent accept is server-owned: stamped
 * from the writing access's delegation marker on create, never taken from
 * the client, kept on update.
 */

const assert = require('node:assert/strict');
const { createApprovedByStampingHook, createApprovedByPreserveHook } = require('../src/approvedByStampingHook.ts');

// Same contract as the delegation plugin's lineageOf: a marker for the
// delegate token and its children, null otherwise.
function lineageOf (access) {
  const d = access?.clientData?.delegation;
  if (d == null || (d.kind !== 'delegate-pat' && d.kind !== 'delegated-child')) return null;
  return { kind: 'delegated-child', relId: d.relId, delegate: d.delegate, viaAccessId: access.id };
}

function run (mw, context) {
  return new Promise((resolve) => mw(context, {}, {}, (err) => resolve(err)));
}

const DELEGATE = { username: 'parent', hostSlug: 'core-a' };
const PAT = { id: 'pat1', type: 'personal', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel1', delegate: DELEGATE } } };
const OWNER = { id: 'own1', type: 'personal', clientData: null };
const FORGED = { delegate: { username: 'someone-else' }, relId: 'rel-forged' };

describe('[APB] cmc/approvedByStampingHook', () => {
  const stamp = createApprovedByStampingHook({ lineageOf });
  const preserve = createApprovedByPreserveHook();

  it('[APB01] an owner accept carries no approvedBy: a client-supplied one is removed', async () => {
    for (const content of [{ capabilityUrl: 'https://t@x/', approvedBy: FORGED }, { capabilityUrl: 'https://t@x/' }]) {
      const context = { access: OWNER, newEvent: { type: 'consent/accept-cmc', content: { ...content } } };
      assert.equal(await run(stamp, context), undefined);
      assert.equal('approvedBy' in context.newEvent.content, false, JSON.stringify(context.newEvent.content));
      assert.equal(context.newEvent.content.capabilityUrl, 'https://t@x/');
    }
  });

  it('[APB02] a delegate accept is stamped from the access marker, whatever the content says', async () => {
    for (const content of [{ capabilityUrl: 'https://t@x/', approvedBy: FORGED }, { capabilityUrl: 'https://t@x/' }]) {
      const context = { access: PAT, newEvent: { type: 'consent/accept-cmc', content: { ...content } } };
      await run(stamp, context);
      assert.deepEqual(context.newEvent.content.approvedBy, { delegate: { username: 'parent', hostSlug: 'core-a' }, relId: 'rel1' });
    }
    // a child of the delegate token: same relationship, and nothing else of
    // the marker (no access id) is copied into the record
    const child = { id: 'c1', clientData: { delegation: { kind: 'delegated-child', relId: 'rel1', delegate: { username: 'parent', hostSlug: 'core-a', extra: 'x' }, viaAccessId: 'pat1' } } };
    const context = { access: child, newEvent: { type: 'consent/accept-cmc', content: {} } };
    await run(stamp, context);
    assert.deepEqual(context.newEvent.content.approvedBy, { delegate: { username: 'parent', hostSlug: 'core-a' }, relId: 'rel1' });
  });

  it('[APB03] hostSlug is copied only when the marker has one', async () => {
    const pat = { id: 'pat2', clientData: { delegation: { kind: 'delegate-pat', relId: 'rel2', delegate: { username: 'parent' } } } };
    const context = { access: pat, newEvent: { type: 'consent/accept-cmc', content: {} } };
    await run(stamp, context);
    assert.deepEqual(context.newEvent.content.approvedBy, { delegate: { username: 'parent' }, relId: 'rel2' });
  });

  it('[APB04] other event types are left as they are', async () => {
    for (const type of ['consent/request-cmc', 'consent/refuse-cmc', 'note/txt']) {
      const context = { access: PAT, newEvent: { type, content: { approvedBy: FORGED } } };
      await run(stamp, context);
      assert.deepEqual(context.newEvent.content, { approvedBy: FORGED }, type);
    }
    const noContent = { access: PAT, newEvent: { type: 'consent/accept-cmc', content: 'text' } };
    assert.equal(await run(stamp, noContent), undefined);
    assert.equal(noContent.newEvent.content, 'text');
  });

  it('[APB05] an update keeps the stored approvedBy and drops a client-supplied one', async () => {
    const stored = { delegate: DELEGATE, relId: 'rel1' };
    const cases = [
      // changed by the client
      { old: { approvedBy: stored, status: 'completed' }, next: { approvedBy: FORGED, status: 'completed', note: 1 }, expect: stored },
      // removed by a content update
      { old: { approvedBy: stored }, next: { note: 1 }, expect: stored },
      // added to an owner accept
      { old: { status: 'completed' }, next: { approvedBy: FORGED }, expect: undefined },
    ];
    for (const c of cases) {
      const next = { ...c.next };
      const context = {
        oldEvent: { type: 'consent/accept-cmc', content: c.old },
        newEvent: { type: 'consent/accept-cmc', content: next },
      };
      assert.equal(await run(preserve, context), undefined);
      assert.deepEqual(context.newEvent.content.approvedBy, c.expect, JSON.stringify(c));
      if (c.expect === undefined) assert.equal('approvedBy' in context.newEvent.content, false);
      if (c.next.note != null) assert.equal(context.newEvent.content.note, 1);
    }
    // an event retyped into an accept gets none
    const retyped = { oldEvent: { type: 'note/txt', content: { approvedBy: FORGED } }, newEvent: { type: 'consent/accept-cmc', content: { approvedBy: FORGED } } };
    await run(preserve, retyped);
    assert.equal('approvedBy' in retyped.newEvent.content, false);
  });

  it('[APB07] a malformed marker (no username or no relId) stamps nothing', async () => {
    for (const delegation of [
      { kind: 'delegate-pat', relId: 'rel1', delegate: {} },
      { kind: 'delegate-pat', relId: '', delegate: DELEGATE },
      { kind: 'delegate-pat', delegate: DELEGATE },
    ]) {
      const context = { access: { id: 'x', clientData: { delegation } }, newEvent: { type: 'consent/accept-cmc', content: { approvedBy: FORGED } } };
      await run(stamp, context);
      assert.equal('approvedBy' in context.newEvent.content, false, JSON.stringify(delegation));
    }
  });

  it('[APB06] an update of another type is left as it is', async () => {
    const context = { oldEvent: { type: 'note/txt', content: {} }, newEvent: { type: 'note/txt', content: { approvedBy: FORGED } } };
    await run(preserve, context);
    assert.deepEqual(context.newEvent.content, { approvedBy: FORGED });
  });
});
