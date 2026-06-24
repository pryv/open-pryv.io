/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — access-mint/widen trigger access-gate tests.
 *
 * [CMCAUTH] covers the events.create middleware that rejects
 * consent/accept-cmc and consent/scope-update-cmc writes when
 * context.access is not personal. (Revoke is access-permission-
 * gated inside handleRevoke via AccessLogic.canDeleteAccess —
 * NOT personal-token-gated at events.create.)
 */

const assert = require('node:assert/strict');
const { createCmcAcceptAccessGateHook, GATED_EVENT_TYPES } = require('../src/cmcAcceptAccessGate.ts');

function fakeErrors () {
  const captured = [];
  return {
    captured,
    factory: {
      invalidOperation (message, details) {
        const e = new Error(message);
        e.details = details;
        captured.push({ message, details });
        return e;
      },
    },
  };
}

function runMiddleware (mw, context, params, result) {
  return new Promise((resolve) => {
    mw(context, params, result, (err) => resolve(err));
  });
}

const PERSONAL = { type: 'personal', isPersonal: () => true };
const APP = { type: 'app', isPersonal: () => false };
const SHARED = { type: 'shared', isPersonal: () => false };
const CAPABILITY = { type: 'shared', isPersonal: () => false, clientData: { cmc: { kind: 'capability' } } };
const COUNTERPARTY = { type: 'shared', isPersonal: () => false, clientData: { cmc: { role: 'counterparty' } } };

describe('[CMCAUTH] cmc/cmcAcceptAccessGate', () => {
  it('[CMCAUTH-PT] passes a personal token through for every gated trigger', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    for (const type of GATED_EVENT_TYPES) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:apps:my-app'], type, content: {} },
        access: PERSONAL,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined, 'expected pass for ' + type);
    }
    assert.equal(errors.captured.length, 0);
  });

  it('[CMCAUTH-AT] rejects accept from an app token with forbidden + correct error id', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:apps:my-app'], type: 'consent/accept-cmc', content: {} },
      access: APP,
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-accept-requires-personal-token');
    assert.equal(err.details.eventType, 'consent/accept-cmc');
  });

  it('[CMCAUTH-ST] rejects accept from a shared token (counterparty role irrelevant at this gate)', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:apps:my-app'], type: 'consent/accept-cmc', content: {} },
      access: SHARED,
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-accept-requires-personal-token');
  });

  it('[CMCAUTH-SU] rejects scope-update from a non-personal access', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:apps:my-app:collectors:peer'], type: 'consent/scope-update-cmc', content: {} },
      access: APP,
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-accept-requires-personal-token');
    assert.equal(err.details.eventType, 'consent/scope-update-cmc');
  });

  it('[CMCAUTH-RV] passes revoke through this gate regardless of token class', async () => {
    // Revoke is access-permission-gated inside handleRevoke (via
    // AccessLogic.canDeleteAccess — honours the `selfRevoke` feature
    // permission), NOT personal-token-gated at events.create. The gate
    // here must pass any token class through; the handler decides.
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    for (const access of [PERSONAL, APP, SHARED]) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:apps:my-app:collectors:peer'], type: 'consent/revoke-cmc', content: {} },
        access,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined, 'expected pass for revoke with ' + access.type);
    }
    assert.equal(errors.captured.length, 0);
  });

  it('[CMCAUTH-UN] passes through un-gated trigger types regardless of token class', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    const unGated = [
      'consent/request-cmc',
      'consent/refuse-cmc',
      'consent/invalidate-link-cmc',
      'consent/scope-request-cmc',
      'message/chat-cmc',
      'notification/alert-cmc',
      'notification/ack-cmc',
      'note/txt',
    ];
    for (const type of unGated) {
      for (const access of [PERSONAL, APP, SHARED]) {
        const ctx = {
          newEvent: { streamIds: ['x'], type, content: {} },
          access,
        };
        const err = await runMiddleware(mw, ctx, {}, {});
        assert.equal(err, undefined, 'expected pass for ' + type + ' with ' + access.type);
      }
    }
    assert.equal(errors.captured.length, 0);
  });

  it('[CMCAUTH-FB] falls back to access.type === "personal" when isPersonal() is absent', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    // Personal-typed access without the isPersonal method passes.
    const personalNoMethod = { type: 'personal' };
    const ctxOk = {
      newEvent: { streamIds: ['x'], type: 'consent/accept-cmc', content: {} },
      access: personalNoMethod,
    };
    assert.equal(await runMiddleware(mw, ctxOk, {}, {}), undefined);
    // App-typed access without the method is rejected.
    const appNoMethod = { type: 'app' };
    const ctxKo = {
      newEvent: { streamIds: ['x'], type: 'consent/accept-cmc', content: {} },
      access: appNoMethod,
    };
    const err = await runMiddleware(mw, ctxKo, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-accept-requires-personal-token');
  });

  it('[CMCAUTH-CAP] passes through writes from a capability-role access (cross-platform accept delivery)', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    // Capability access POSTs the accept event into requester's
    // :_cmc:_internal:responses:<capId> via the capability connection.
    // Without this exemption the gate would block the handshake.
    for (const type of GATED_EVENT_TYPES) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:_internal:responses:capid'], type, content: {} },
        access: CAPABILITY,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined, 'expected pass for capability access + ' + type);
    }
  });

  it('[CMCAUTH-CP] passes through writes from a counterparty-role access (peer-delivered protocol events)', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    for (const type of GATED_EVENT_TYPES) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:inbox'], type, content: {} },
        access: COUNTERPARTY,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined, 'expected pass for counterparty access + ' + type);
    }
  });

  it('[CMCAUTH-NV] passes through when newEvent is missing (defensive)', async () => {
    const errors = fakeErrors();
    const mw = createCmcAcceptAccessGateHook({ errors: errors.factory });
    const err = await runMiddleware(mw, { access: APP }, {}, {});
    assert.equal(err, undefined);
  });
});
