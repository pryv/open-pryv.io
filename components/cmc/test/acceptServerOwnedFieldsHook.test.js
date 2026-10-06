/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [APB] The server-owned fields of a consent accept (`approvedBy`,
 * `ownerConfirmedAt`, `withdrawal`): never taken from the client on create
 * (`approvedBy` is stamped from the writing access's delegation marker), the
 * stored values kept on update.
 */

const assert = require('node:assert/strict');
const { createAcceptStampingHook, createAcceptPreserveHook, preserveServerOwnedContent } = require('../src/acceptServerOwnedFieldsHook.ts');

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

const CONFIRMED_AT = 1_700_000_100;
const WITHDRAWAL = { at: 1_700_000_200, by: 'delegation-detach', relId: 'rel1' };

describe('[APB] cmc/acceptServerOwnedFieldsHook', () => {
  const stamp = createAcceptStampingHook({ lineageOf });
  const preserve = createAcceptPreserveHook();

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

  it('[APB08] an owner create cannot write any of the three fields', async () => {
    const context = {
      access: OWNER,
      newEvent: { type: 'consent/accept-cmc', content: { capabilityUrl: 'https://t@x/', approvedBy: FORGED, ownerConfirmedAt: CONFIRMED_AT, withdrawal: WITHDRAWAL } },
    };
    await run(stamp, context);
    assert.deepEqual(context.newEvent.content, { capabilityUrl: 'https://t@x/' });
  });

  it('[APB09] a delegate create cannot claim the owner confirmed or ended the consent', async () => {
    const context = {
      access: PAT,
      newEvent: { type: 'consent/accept-cmc', content: { capabilityUrl: 'https://t@x/', ownerConfirmedAt: CONFIRMED_AT, withdrawal: WITHDRAWAL } },
    };
    await run(stamp, context);
    assert.deepEqual(context.newEvent.content, {
      capabilityUrl: 'https://t@x/',
      approvedBy: { delegate: { username: 'parent', hostSlug: 'core-a' }, relId: 'rel1' },
    });
  });

  it('[APB10] an update that omits the stored fields does not erase them', async () => {
    const stored = { approvedBy: { delegate: DELEGATE, relId: 'rel1' }, ownerConfirmedAt: CONFIRMED_AT, withdrawal: WITHDRAWAL };
    const context = {
      oldEvent: { type: 'consent/accept-cmc', content: { status: 'completed', ...stored } },
      newEvent: { type: 'consent/accept-cmc', content: { status: 'completed', note: 'edited' } },
    };
    await run(preserve, context);
    assert.deepEqual(context.newEvent.content, { status: 'completed', note: 'edited', ...stored });
  });

  it('[APB11] an update that sends other values keeps the stored ones, and the rest as sent', async () => {
    const stored = { approvedBy: { delegate: DELEGATE, relId: 'rel1' }, ownerConfirmedAt: CONFIRMED_AT, withdrawal: WITHDRAWAL };
    const context = {
      oldEvent: { type: 'consent/accept-cmc', content: { status: 'completed', note: 'before', ...stored } },
      newEvent: {
        type: 'consent/accept-cmc',
        content: { status: 'completed', note: 'after', approvedBy: FORGED, ownerConfirmedAt: 1, withdrawal: { at: 1, by: 'someone', relId: 'x' } },
      },
    };
    await run(preserve, context);
    assert.deepEqual(context.newEvent.content, { status: 'completed', note: 'after', ...stored });
  });

  it('[APB12] an update cannot add the fields to an accept that has none', async () => {
    const context = {
      oldEvent: { type: 'consent/accept-cmc', content: { status: 'completed' } },
      newEvent: { type: 'consent/accept-cmc', content: { status: 'completed', approvedBy: FORGED, ownerConfirmedAt: CONFIRMED_AT, withdrawal: WITHDRAWAL } },
    };
    await run(preserve, context);
    assert.deepEqual(context.newEvent.content, { status: 'completed' });
  });

  it('[APB13] on every CMC type, the dispatch status and failure are kept from storage', async () => {
    const context = {
      oldEvent: { type: 'message/chat-cmc', content: { content: 'hi', status: 'failed', failure: { reason: 'peer-down' } } },
      newEvent: { type: 'message/chat-cmc', content: { content: 'edited', status: 'completed' } },
    };
    await run(preserve, context);
    assert.deepEqual(context.newEvent.content, { content: 'edited', status: 'failed', failure: { reason: 'peer-down' } });
  });

  it('[APB15] an update sending non-object content on a CMC event is refused; one without content is not', async () => {
    const errors = { invalidParametersFormat: (message, data) => Object.assign(new Error(message), { id: 'invalid-parameters-format', data }) };
    const guarded = createAcceptPreserveHook({ errors });
    const oldEvent = { type: 'consent/accept-cmc', content: { status: 'completed', withdrawal: WITHDRAWAL } };
    const refused = { oldEvent, newEvent: { type: 'consent/accept-cmc', content: 'x' } };
    const err = await new Promise((resolve) => guarded(refused, { update: { content: 'x' } }, {}, resolve));
    assert.equal(err?.id, 'invalid-parameters-format');
    const untouched = { oldEvent, newEvent: { type: 'consent/accept-cmc', content: { ...oldEvent.content }, description: 'd' } };
    const ok = await new Promise((resolve) => guarded(untouched, { update: { description: 'd' } }, {}, resolve));
    assert.equal(ok, undefined);
    assert.deepEqual(untouched.newEvent.content, oldEvent.content);
  });

  it('[APB14] preserveServerOwnedContent takes the server-owned fields from its first argument', () => {
    const read = { type: 'consent/accept-cmc', content: { status: 'delivered' } };
    const storedNow = { type: 'consent/accept-cmc', content: { status: 'completed', withdrawal: WITHDRAWAL } };
    const event = { type: 'consent/accept-cmc', content: { note: 'x', status: 'forged' } };
    assert.deepEqual(preserveServerOwnedContent(storedNow, event), { note: 'x', status: 'completed', withdrawal: WITHDRAWAL });
    assert.deepEqual(preserveServerOwnedContent(read, event), { note: 'x', status: 'delivered' });
    // not a CMC type: the content as is (same object)
    const note = { type: 'note/txt', content: 'plain' };
    assert.strictEqual(preserveServerOwnedContent(read, note), 'plain');
  });
});
