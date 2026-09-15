/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');

describe('[DELCONST] delegation/constants', () => {
  it('[DC01] namespace roots have the expected literal values', () => {
    assert.equal(C.NS, ':_delegation:');
    assert.equal(C.NS_INTERNAL, ':_delegation:_internal');
    assert.deepEqual(C.RESERVED_PARENT_STREAM_IDS, [':_delegation:', ':_delegation:_internal']);
  });

  it('[DC02] stream-id builders compose under the internal namespace', () => {
    assert.equal(C.delegatesStreamId(), ':_delegation:_internal:delegates');
    assert.equal(C.controlledStreamId(), ':_delegation:_internal:controlled');
    assert.equal(C.responsesStreamIdFor('rel1'), ':_delegation:_internal:responses:rel1');
    assert.equal(C.notifyStreamIdFor('rel1'), ':_delegation:_internal:notify:rel1');
    assert.equal(C.ctlStreamIdFor('rel1'), ':_delegation:_internal:ctl:rel1');
  });

  it('[DC03] isDelegationStreamId matches the namespace + bare root', () => {
    assert.equal(C.isDelegationStreamId(':_delegation'), true);
    assert.equal(C.isDelegationStreamId(':_delegation:'), true);
    assert.equal(C.isDelegationStreamId(':_delegation:_internal'), true);
    assert.equal(C.isDelegationStreamId(':_delegation:_internal:delegates'), true);
    assert.equal(C.isDelegationStreamId('fertility'), false);
    assert.equal(C.isDelegationStreamId(':_cmc:inbox'), false);
  });

  it('[DC04] isDelegationInternalStreamId matches only the internal subtree', () => {
    assert.equal(C.isDelegationInternalStreamId(':_delegation:_internal'), true);
    assert.equal(C.isDelegationInternalStreamId(':_delegation:_internal:controlled'), true);
    assert.equal(C.isDelegationInternalStreamId(':_delegation:'), false);
    assert.equal(C.isDelegationInternalStreamId('fertility'), false);
  });

  it('[DC05] event types + isDelegationEventType', () => {
    assert.equal(C.ET_ANCHOR, 'delegation/delegate');
    assert.equal(C.ET_MIRROR, 'delegation/controlled');
    assert.deepEqual(C.ALL_EVENT_TYPES, ['delegation/delegate', 'delegation/controlled']);
    assert.equal(C.isDelegationEventType('delegation/delegate'), true);
    assert.equal(C.isDelegationEventType('delegation/controlled'), true);
    assert.equal(C.isDelegationEventType('delegation/unknown'), false);
    assert.equal(C.isDelegationEventType('note/txt'), false);
    assert.equal(C.isDelegationEventType(null), false);
  });

  it('[DC06] clientData kinds + statuses', () => {
    assert.deepEqual(C.CLIENTDATA_KIND, {
      CONTROL: 'control',
      DELEGATE_PAT: 'delegate-pat',
      INVITE_CAPABILITY: 'invite-capability',
      NOTIFY: 'notify',
    });
    assert.deepEqual(C.STATUS, { INVITE: 'invite', ACTIVE: 'active', STALE: 'stale' });
  });
});
