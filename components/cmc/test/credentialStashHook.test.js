/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — pre-persist credential stash hook tests.
 *
 * [CMCSTASH] covers createCredentialStashHook: the token leaves the content
 * BEFORE it is stored, and travels on context.cmc.credentials instead.
 */

const assert = require('node:assert/strict');
const { createCredentialStashHook } = require('../src/credentialStashHook.ts');

const CAP_WITH_TOKEN = 'https://CapTok@requester.example.com/';
const CAP_NO_TOKEN = 'https://requester.example.com/';
const BC_WITH_TOKEN = 'https://BcTok@provider.example.com/';
const BC_NO_TOKEN = 'https://provider.example.com/';

/** Run the hook over a context; returns { context, err }. */
function run (newEvent, seedContext) {
  const hook = createCredentialStashHook();
  const context = { ...(seedContext || {}), newEvent };
  let err;
  hook(context, {}, {}, (e) => { err = e; });
  return { context, err };
}

describe('[CMCSTASH] cmc/credentialStashHook', () => {
  it('[CST1] back-channel: the token leaves the content and lands in the stash', () => {
    const { context, err } = run({
      type: 'consent/back-channel-cmc',
      streamIds: [':_cmc:inbox'],
      content: {
        from: { username: 'provider-a', host: 'example.com' },
        apiEndpoint: BC_WITH_TOKEN,
        remoteChatStreamId: ':_cmc:apps:my-app:chats:provider-a',
        remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:provider-a',
        appCode: 'my-app',
      },
    });
    assert.equal(err, undefined);
    // What gets persisted:
    assert.equal(context.newEvent.content.apiEndpoint, BC_NO_TOKEN);
    assert.equal(JSON.stringify(context.newEvent.content).includes('BcTok'), false);
    // ...with everything it is read for intact:
    assert.deepEqual(context.newEvent.content.from, { username: 'provider-a', host: 'example.com' });
    assert.equal(context.newEvent.content.remoteChatStreamId, ':_cmc:apps:my-app:chats:provider-a');
    assert.equal(context.newEvent.content.remoteCollectorStreamId, ':_cmc:apps:my-app:collectors:provider-a');
    assert.equal(context.newEvent.content.appCode, 'my-app');
    // ...and the usable value carried on the side:
    assert.deepEqual(context.cmc.credentials, { apiEndpoint: BC_WITH_TOKEN });
  });

  it('[CST2] accept trigger: capabilityUrl is stashed', () => {
    const { context } = run({
      type: 'consent/accept-cmc',
      streamIds: [':_cmc:apps:my-app'],
      content: { capabilityUrl: CAP_WITH_TOKEN, accessName: 'grant-1' },
    });
    assert.equal(context.newEvent.content.capabilityUrl, CAP_NO_TOKEN);
    assert.equal(context.newEvent.content.accessName, 'grant-1');
    assert.deepEqual(context.cmc.credentials, { capabilityUrl: CAP_WITH_TOKEN });
  });

  it('[CST3] refuse trigger: capabilityUrl is stashed', () => {
    const { context } = run({
      type: 'consent/refuse-cmc',
      streamIds: [':_cmc:apps:my-app'],
      content: { capabilityUrl: CAP_WITH_TOKEN, reason: { en: 'no' } },
    });
    assert.equal(context.newEvent.content.capabilityUrl, CAP_NO_TOKEN);
    assert.deepEqual(context.newEvent.content.reason, { en: 'no' });
    assert.deepEqual(context.cmc.credentials, { capabilityUrl: CAP_WITH_TOKEN });
  });

  it('[CST4] consent/request-cmc passes through UNCHANGED: its capabilityUrl is the deliverable', () => {
    // The invite URL the app hands out; listInvites reads it back off this row.
    const { context } = run({
      type: 'consent/request-cmc',
      streamIds: [':_cmc:apps:my-app'],
      content: { capabilityUrl: CAP_WITH_TOKEN, capabilityId: 'cap-x' },
    });
    assert.equal(context.newEvent.content.capabilityUrl, CAP_WITH_TOKEN);
    assert.equal(context.cmc, undefined);
  });

  it('[CST5] a peer accept keeps grantedAccess.apiEndpoint and sets no stash', () => {
    // waitForAccept() reads this off the stored event and apps open a
    // connection with it. A future widening of the scrub key list must not
    // silently break that contract.
    const { context } = run({
      type: 'consent/accept-cmc',
      streamIds: [':_cmc:_internal:responses:cap-x'],
      content: {
        from: { username: 'bob', host: 'b.example.com' },
        grantedAccess: { apiEndpoint: BC_WITH_TOKEN },
        capabilityId: 'cap-x',
      },
    });
    assert.equal(context.newEvent.content.grantedAccess.apiEndpoint, BC_WITH_TOKEN);
    assert.equal(context.cmc, undefined);
  });

  it('[CST6] non-CMC types, missing content and token-less content pass through', () => {
    const plain = run({ type: 'note/txt', content: { capabilityUrl: CAP_WITH_TOKEN } });
    assert.equal(plain.context.newEvent.content.capabilityUrl, CAP_WITH_TOKEN);
    assert.equal(plain.context.cmc, undefined);

    const noContent = run({ type: 'consent/accept-cmc' });
    assert.equal(noContent.err, undefined);
    assert.equal(noContent.context.cmc, undefined);

    const alreadyClean = run({
      type: 'consent/accept-cmc',
      content: { capabilityUrl: CAP_NO_TOKEN },
    });
    assert.equal(alreadyClean.context.newEvent.content.capabilityUrl, CAP_NO_TOKEN);
    assert.equal(alreadyClean.context.cmc, undefined);

    const noEvent = run(undefined);
    assert.equal(noEvent.err, undefined);
  });

  it('[CST7] preserves anything an earlier hook already put on context.cmc', () => {
    const { context } = run({
      type: 'consent/back-channel-cmc',
      content: { apiEndpoint: BC_WITH_TOKEN },
    }, { cmc: { inboxWrite: { counterparty: { username: 'provider-a', host: 'example.com' } } } });
    assert.deepEqual(context.cmc.inboxWrite,
      { counterparty: { username: 'provider-a', host: 'example.com' } });
    assert.deepEqual(context.cmc.credentials, { apiEndpoint: BC_WITH_TOKEN });
  });
});
