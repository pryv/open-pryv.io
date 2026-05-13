/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 Phase C — cmc/* content validator tests.
 *
 * [CMCVAL] suite covers the write-side schemas every CMC event type
 * has to satisfy before the orchestration loop sees the trigger.
 */

const assert = require('node:assert/strict');
const V = require('../src/validators.ts');

function expectValid (eventType, content) {
  const r = V.validate(eventType, content);
  assert.deepEqual(
    { valid: r.valid, errors: r.errors },
    { valid: true, errors: [] },
    `expected ${eventType} to validate; got errors: ${r.errors.join('; ')}`
  );
}

function expectInvalid (eventType, content, mustIncludeSubstr) {
  const r = V.validate(eventType, content);
  assert.equal(r.valid, false, `expected ${eventType} to fail validation`);
  if (mustIncludeSubstr) {
    assert.ok(
      r.errors.some((e) => e.includes(mustIncludeSubstr)),
      `expected error to include "${mustIncludeSubstr}"; got: ${r.errors.join('; ')}`
    );
  }
}

const VALID_PERMS = [
  { streamId: 'fertility', level: 'read' },
  { streamId: 'symptom', level: 'read' },
];

const VALID_REQUEST = {
  to: null,
  capabilityRequested: true,
  request: {
    title: { en: 'STORMM consent' },
    description: { en: 'Share fertility + symptom data for 3 months.' },
    consent: { en: 'I agree.' },
    permissions: VALID_PERMS,
    features: { chat: true, systemMessaging: false },
    expiresAt: 1736294400,
  },
  requesterMeta: { displayName: 'Dr. Smith — STORMM', appId: 'stormm-doctor-dashboard' },
};

describe('[CMCVAL] cmc/validators', () => {
  describe('[CMCVAL-DISP] dispatcher', () => {
    it('[V01] isKnownEventType true for every event type in the catalogue', () => {
      const C = require('../src/constants.ts');
      for (const t of [
        ...C.EVENT_TYPES_LIFECYCLE,
        ...C.EVENT_TYPES_CHAT,
        ...C.EVENT_TYPES_SYSTEM,
      ]) {
        assert.ok(V.isKnownEventType(t), `expected ${t} to be known`);
      }
    });

    it('[V02] unknown event types are rejected with a clear message', () => {
      const r = V.validate('cmc/nonsense-v1', {});
      assert.equal(r.valid, false);
      assert.ok(r.errors.some((e) => e.includes('unknown cmc event type')));
    });
  });

  describe('[CMCVAL-REQ] cmc/request-v1', () => {
    it('[VR01] accepts a fully-formed open-invite request', () => {
      expectValid('cmc/request-v1', VALID_REQUEST);
    });

    it('[VR02] accepts a directed invite with `to`', () => {
      expectValid('cmc/request-v1', { ...VALID_REQUEST, to: 'jane' });
    });

    it('[VR03] rejects missing request.permissions', () => {
      const bad = { ...VALID_REQUEST, request: { ...VALID_REQUEST.request, permissions: undefined } };
      expectInvalid('cmc/request-v1', bad, 'permissions');
    });

    it('[VR04] rejects request.permissions with unknown level', () => {
      const bad = {
        ...VALID_REQUEST,
        request: {
          ...VALID_REQUEST.request,
          permissions: [{ streamId: 'x', level: 'admin' }],
        },
      };
      expectInvalid('cmc/request-v1', bad, 'level');
    });

    it('[VR05] rejects localizable text given as plain string', () => {
      const bad = {
        ...VALID_REQUEST,
        request: { ...VALID_REQUEST.request, title: 'STORMM consent' },
      };
      expectInvalid('cmc/request-v1', bad, 'title');
    });

    it('[VR06] rejects non-boolean features.chat', () => {
      const bad = {
        ...VALID_REQUEST,
        request: { ...VALID_REQUEST.request, features: { chat: 'yes' } },
      };
      expectInvalid('cmc/request-v1', bad, 'features.chat');
    });
  });

  describe('[CMCVAL-ACC] cmc/accept-v1', () => {
    it('[VA01] accepts a minimal accept', () => {
      expectValid('cmc/accept-v1', { capabilityUrl: 'https://AbC@datasafe.dev/' });
    });

    it('[VA02] accepts extra + accessName', () => {
      expectValid('cmc/accept-v1', {
        capabilityUrl: 'https://AbC@datasafe.dev/',
        extra: { chat: true },
        accessName: 'STORMM by Dr. Smith',
      });
    });

    it('[VA03] rejects missing capabilityUrl', () => {
      expectInvalid('cmc/accept-v1', {}, 'capabilityUrl');
    });
  });

  describe('[CMCVAL-REF] cmc/refuse-v1', () => {
    it('[VF01] accepts refuse with localizable reason', () => {
      expectValid('cmc/refuse-v1', {
        capabilityUrl: 'https://AbC@datasafe.dev/',
        reason: { en: 'Not at this time.' },
      });
    });

    it('[VF02] rejects refuse without capabilityUrl', () => {
      expectInvalid('cmc/refuse-v1', { reason: { en: 'no' } }, 'capabilityUrl');
    });
  });

  describe('[CMCVAL-REV] cmc/revoke-v1', () => {
    it('[VRK01] accepts revoke with accessId', () => {
      expectValid('cmc/revoke-v1', { accessId: 'abc123' });
    });

    it('[VRK02] rejects revoke without accessId', () => {
      expectInvalid('cmc/revoke-v1', {}, 'accessId');
    });
  });

  describe('[CMCVAL-CHA] cmc/chat-v1', () => {
    it('[VC01] accepts short chat message', () => {
      expectValid('cmc/chat-v1', { content: 'Hello!' });
    });

    it('[VC02] rejects empty content', () => {
      expectInvalid('cmc/chat-v1', { content: '' }, 'content');
    });

    it('[VC03] rejects > 10 KB content', () => {
      const big = 'x'.repeat(10 * 1024 + 1);
      expectInvalid('cmc/chat-v1', { content: big }, '10 KB');
    });
  });

  describe('[CMCVAL-SYS] cmc/system-alert-v1 + cmc/system-ack-v1', () => {
    it('[VS01] accepts info alert with ackRequired', () => {
      expectValid('cmc/system-alert-v1', {
        level: 'info',
        title: { en: 'Daily check-in' },
        body: { en: 'Complete today\'s questionnaire.' },
        ackRequired: true,
        ackId: 'daily-2026-05-13',
      });
    });

    it('[VS02] rejects alert with invalid level', () => {
      expectInvalid(
        'cmc/system-alert-v1',
        { level: 'urgent', title: { en: 'x' }, body: { en: 'x' } },
        'level'
      );
    });

    it('[VS03] accepts ack with alertEventId + ackId', () => {
      expectValid('cmc/system-ack-v1', { alertEventId: 'evt123', ackId: 'daily-2026-05-13' });
    });

    it('[VS04] rejects ack missing ackId', () => {
      expectInvalid('cmc/system-ack-v1', { alertEventId: 'evt123' }, 'ackId');
    });
  });

  describe('[CMCVAL-SCO] system-scope-request + system-scope-update', () => {
    it('[VC04] accepts scope-request with newPermissions + message', () => {
      expectValid('cmc/system-scope-request-v1', {
        newPermissions: [{ streamId: 'nutrition', level: 'read' }],
        message: { en: 'Could I also see your nutrition log?' },
      });
    });

    it('[VC05] rejects scope-request with empty permissions array', () => {
      expectInvalid(
        'cmc/system-scope-request-v1',
        { newPermissions: [] },
        'newPermissions'
      );
    });

    it('[VC06] accepts scope-update as response (scopeRequestEventId + accept)', () => {
      expectValid('cmc/system-scope-update-v1', {
        scopeRequestEventId: 'evt-req-123',
        accept: true,
      });
    });

    it('[VC07] accepts scope-update as self-initiated (newPermissions only)', () => {
      expectValid('cmc/system-scope-update-v1', {
        newPermissions: [{ streamId: 'sleep', level: 'read' }],
      });
    });

    it('[VC08] rejects scope-update with neither request-ref nor newPermissions', () => {
      expectInvalid('cmc/system-scope-update-v1', { accept: true }, 'scopeRequestEventId');
    });
  });
});
