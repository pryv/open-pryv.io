/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accessesUpdateHook tests.
 *
 * [CMCAU] covers the accesses.update post-hook + AsyncLocalStorage-based
 * suppression for CMC-handler-initiated updates.
 */

const assert = require('node:assert/strict');
const {
  createAccessesUpdatePostHook,
  isSuppressed,
  runWithSuppression,
} = require('../src/accessesUpdateHook.ts');

function fakeMall (opts = {}) {
  const calls = { eventsCreated: [] };
  return {
    calls,
    events: {
      async create (_userId, params) {
        calls.eventsCreated.push(params);
        if (opts.failEventCreate) throw new Error('event-fail');
        return { id: 'ev-' + calls.eventsCreated.length, ...params };
      },
    },
  };
}

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
      calls.push({ url, init });
      const spec = Array.isArray(responses) ? responses[idx++] : responses;
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        async json () { return spec.body; },
        async text () { return JSON.stringify(spec.body); },
      });
    },
    calls,
  };
}

const CMC_COUNTERPARTY_ACCESS = {
  id: 'acc-counterparty',
  permissions: [{ streamId: 's', level: 'read' }],
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: {
        username: 'alice',
        host: 'pryv.me',
        apiEndpoint: 'https://peer-tok@pryv.me/',
      },
    },
  },
};

describe('[CMCAU] cmc/accessesUpdateHook', () => {
  describe('[CMCAU-RUN] post-hook fires for CMC accesses', () => {
    it('[AU01] writes local audit + delivers to peer on counterparty access update', async () => {
      const mall = fakeMall();
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      const r = await hook(
        'u1',
        { ...CMC_COUNTERPARTY_ACCESS, permissions: [] },
        { ...CMC_COUNTERPARTY_ACCESS, permissions: [{ streamId: 'x', level: 'read' }] }
      );
      assert.equal(r.ran, true);
      assert.equal(r.peerNotified, true);
      assert.ok(r.localAuditEventId);
      // Local audit event written to OUR collectors stream
      assert.equal(mall.calls.eventsCreated.length, 1);
      assert.deepEqual(mall.calls.eventsCreated[0].streamIds, [
        ':_cmc:apps:my-app:collectors:alice--pryv-me',
      ]);
      assert.equal(mall.calls.eventsCreated[0].type, 'cmc/system-scope-update-v1');
      // Outbound POST to peer's :_cmc:inbox
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://pryv.me/events');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.type, 'cmc/system-scope-update-v1');
      assert.deepEqual(sent.streamIds, [':_cmc:inbox']);
      assert.equal(sent.content.source, 'post-hook');
      assert.deepEqual(sent.content.newPermissions, [{ streamId: 'x', level: 'read' }]);
    });

    it('[AU02] also fires for data-grant access role', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      const r = await hook(
        'u1',
        undefined,
        {
          ...CMC_COUNTERPARTY_ACCESS,
          clientData: {
            cmc: { ...CMC_COUNTERPARTY_ACCESS.clientData.cmc, role: 'data-grant' },
          },
        }
      );
      assert.equal(r.ran, true);
    });
  });

  describe('[CMCAU-SKIP] post-hook skips non-CMC + missing-apiendpoint', () => {
    it('[AU03] skips when access has no clientData.cmc', async () => {
      const mall = fakeMall();
      const hook = createAccessesUpdatePostHook({ mall, fetch: fakeFetch({}).fetch });
      const r = await hook('u1', undefined, { id: 'a', clientData: {} });
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'not-a-cmc-managed-access');
    });

    it('[AU04] skips when role is not counterparty or data-grant', async () => {
      const mall = fakeMall();
      const hook = createAccessesUpdatePostHook({ mall, fetch: fakeFetch({}).fetch });
      const r = await hook('u1', undefined, {
        id: 'a',
        clientData: { cmc: { role: 'capability' } },
      });
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'not-a-cmc-managed-access');
    });

    it('[AU05] skips when counterparty.apiEndpoint is missing', async () => {
      const mall = fakeMall();
      const hook = createAccessesUpdatePostHook({ mall, fetch: fakeFetch({}).fetch });
      const acc = {
        ...CMC_COUNTERPARTY_ACCESS,
        clientData: {
          cmc: {
            ...CMC_COUNTERPARTY_ACCESS.clientData.cmc,
            counterparty: { username: 'a', host: 'b.com' }, // no apiEndpoint
          },
        },
      };
      const r = await hook('u1', undefined, acc);
      assert.equal(r.ran, false);
      assert.equal(r.reason, 'no-peer-apiendpoint');
    });
  });

  describe('[CMCAU-SUP] suppression', () => {
    it('[AU06] runWithSuppression sets the flag for the duration of the fn', async () => {
      assert.equal(isSuppressed(), false);
      let inFlag = null;
      await runWithSuppression(async () => {
        inFlag = isSuppressed();
      });
      assert.equal(inFlag, true);
      // Flag is back off outside the wrapped fn.
      assert.equal(isSuppressed(), false);
    });

    it('[AU07] hook skips when invoked inside runWithSuppression', async () => {
      const mall = fakeMall();
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      let res;
      await runWithSuppression(async () => {
        res = await hook('u1', undefined, CMC_COUNTERPARTY_ACCESS);
      });
      assert.equal(res.ran, false);
      assert.equal(res.reason, 'suppressed-by-cmc-handler');
      // No outbound delivery, no local audit
      assert.equal(calls.length, 0);
      assert.equal(mall.calls.eventsCreated.length, 0);
    });

    it('[AU08] suppression is per-async-context — concurrent non-suppressed call still fires', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch([
        { status: 201, body: {} },
        { status: 201, body: {} },
      ]);
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      // One call inside suppression, one outside, in parallel.
      const [a, b] = await Promise.all([
        runWithSuppression(async () => hook('u1', undefined, CMC_COUNTERPARTY_ACCESS)),
        hook('u1', undefined, CMC_COUNTERPARTY_ACCESS),
      ]);
      assert.equal(a.ran, false);
      assert.equal(b.ran, true);
    });
  });

  describe('[CMCAU-FAIL] hook resilience', () => {
    it('[AU09] local audit-event failure is logged + does not block peer delivery', async () => {
      const mall = fakeMall({ failEventCreate: true });
      const { fetch } = fakeFetch({ status: 201, body: {} });
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      const r = await hook('u1', undefined, CMC_COUNTERPARTY_ACCESS);
      assert.equal(r.ran, true);
      assert.equal(r.peerNotified, true);
      assert.equal(r.localAuditEventId, undefined);
    });

    it('[AU10] peer-5xx surfaces peerNotified=false but hook does not throw', async () => {
      const mall = fakeMall();
      const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
      const hook = createAccessesUpdatePostHook({ mall, fetch });
      const r = await hook('u1', undefined, CMC_COUNTERPARTY_ACCESS);
      assert.equal(r.ran, true);
      assert.equal(r.peerNotified, false);
      assert.equal(r.peerDeliveryStatus, 503);
    });
  });
});
