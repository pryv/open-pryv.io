/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — :_cmc:inbox write-hook tests.
 *
 * [CMCINBOX] covers the validator that rejects non-counterparty access
 * writes to :_cmc:inbox + stamps content.from from the access identity.
 */

const assert = require('node:assert/strict');
const { createInboxWriteHook } = require('../src/inboxWriteHook.ts');

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

const COUNTERPARTY_ACCESS = {
  id: 'acc-back-channel',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      counterparty: { username: 'alice', host: 'example.com' },
    },
  },
};

describe('[CMCINBOX] cmc/inboxWriteHook', () => {
  it('[CI01] passes through writes outside :_cmc:inbox', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: ['fertility'], type: 'note/txt', content: 'x' },
      access: { clientData: {} },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.equal(errors.captured.length, 0);
  });

  it('[CI02] rejects inbox write from a non-counterparty access', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:inbox'], type: 'cmc/accept-v1', content: {} },
      access: { clientData: { cmc: { role: 'capability' } } },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-not-counterparty');
  });

  it('[CI03] rejects inbox write from a personal access (no cmc clientData)', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:inbox'], type: 'cmc/accept-v1', content: {} },
      access: { clientData: {} },
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-not-counterparty');
  });

  it('[CI04] rejects inbox write with non-lifecycle event type', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    for (const type of ['cmc/chat-v1', 'cmc/system-alert-v1', 'note/txt']) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:inbox'], type, content: {} },
        access: COUNTERPARTY_ACCESS,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.ok(err instanceof Error, 'expected reject for ' + type);
      assert.equal(err.details.id, 'cmc-event-type-not-allowed');
      assert.equal(err.details.eventType, type);
    }
  });

  it('[CI05] accepts each lifecycle event type (request/accept/refuse/revoke)', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    for (const type of ['cmc/request-v1', 'cmc/accept-v1', 'cmc/refuse-v1', 'cmc/revoke-v1']) {
      const ctx = {
        newEvent: { streamIds: [':_cmc:inbox'], type, content: {} },
        access: COUNTERPARTY_ACCESS,
      };
      const err = await runMiddleware(mw, ctx, {}, {});
      assert.equal(err, undefined, 'expected pass for ' + type);
    }
  });

  it('[CI06] stamps content.from from the access\'s stored counterparty identity', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:inbox'], type: 'cmc/accept-v1', content: { grantedAccess: { apiEndpoint: 'X' } } },
      access: COUNTERPARTY_ACCESS,
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.deepEqual(ctx.newEvent.content.from, { username: 'alice', host: 'example.com' });
    // Other content preserved
    assert.deepEqual(ctx.newEvent.content.grantedAccess, { apiEndpoint: 'X' });
    // Marker recorded on context
    assert.deepEqual(ctx.cmc.inboxWrite, {
      counterparty: { username: 'alice', host: 'example.com' },
    });
  });

  it('[CI07] overwrites any forged from-field that the sender included', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: {
        streamIds: [':_cmc:inbox'],
        type: 'cmc/accept-v1',
        content: { from: { username: 'evil', host: 'attacker.example' } },
      },
      access: COUNTERPARTY_ACCESS,
    };
    await runMiddleware(mw, ctx, {}, {});
    // Forged from overwritten with the access's identity
    assert.deepEqual(ctx.newEvent.content.from, { username: 'alice', host: 'example.com' });
  });

  it('[CI08] rejects when counterparty access has malformed identity', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: { streamIds: [':_cmc:inbox'], type: 'cmc/accept-v1', content: {} },
      access: { clientData: { cmc: { role: 'counterparty', counterparty: { username: 'alice' } } } }, // no host
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.ok(err instanceof Error);
    assert.equal(err.details.id, 'cmc-counterparty-identity-missing');
  });

  it('[CI09] handles inbox + other streamIds in the same event', async () => {
    const errors = fakeErrors();
    const mw = createInboxWriteHook({ errors: errors.factory });
    const ctx = {
      newEvent: {
        streamIds: ['some-other-stream', ':_cmc:inbox'],
        type: 'cmc/refuse-v1',
        content: {},
      },
      access: COUNTERPARTY_ACCESS,
    };
    const err = await runMiddleware(mw, ctx, {}, {});
    assert.equal(err, undefined);
    assert.deepEqual(ctx.newEvent.content.from, { username: 'alice', host: 'example.com' });
  });
});
