/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * cmc/* content validator tests.
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
    title: { en: 'example consent' },
    description: { en: 'share fertility + symptom data for 3 months' },
    consent: { en: 'I agree.' },
    permissions: VALID_PERMS,
    features: { chat: true, systemMessaging: false },
    expiresAt: 1736294400,
  },
  requesterMeta: { displayName: 'Dr. Smith — Example', appId: 'example-app' },
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

  describe('[CMCVAL-REQ] consent/request-cmc', () => {
    it('[VR01] accepts a fully-formed open-invite request', () => {
      expectValid('consent/request-cmc', VALID_REQUEST);
    });

    it('[VR02] accepts a directed invite with `to`', () => {
      expectValid('consent/request-cmc', { ...VALID_REQUEST, to: 'jane' });
    });

    it('[VR03] rejects missing request.permissions', () => {
      const bad = { ...VALID_REQUEST, request: { ...VALID_REQUEST.request, permissions: undefined } };
      expectInvalid('consent/request-cmc', bad, 'permissions');
    });

    it('[VR04] rejects request.permissions with unknown level', () => {
      const bad = {
        ...VALID_REQUEST,
        request: {
          ...VALID_REQUEST.request,
          permissions: [{ streamId: 'x', level: 'admin' }],
        },
      };
      expectInvalid('consent/request-cmc', bad, 'level');
    });

    it('[VR05] rejects localizable text given as plain string', () => {
      const bad = {
        ...VALID_REQUEST,
        request: { ...VALID_REQUEST.request, title: 'example consent' },
      };
      expectInvalid('consent/request-cmc', bad, 'title');
    });

    it('[VR06] rejects non-boolean features.chat', () => {
      const bad = {
        ...VALID_REQUEST,
        request: { ...VALID_REQUEST.request, features: { chat: 'yes' } },
      };
      expectInvalid('consent/request-cmc', bad, 'features.chat');
    });
  });

  describe('[CMCVAL-ACC] consent/accept-cmc', () => {
    it('[VA01] accepts a minimal accept', () => {
      expectValid('consent/accept-cmc', { capabilityUrl: 'https://AbC@example.com/' });
    });

    it('[VA02] accepts extra + accessName', () => {
      expectValid('consent/accept-cmc', {
        capabilityUrl: 'https://AbC@example.com/',
        extra: { chat: true },
        accessName: 'Example access',
      });
    });

    it('[VA03] rejects missing capabilityUrl', () => {
      expectInvalid('consent/accept-cmc', {}, 'capabilityUrl');
    });
  });

  describe('[CMCVAL-REF] consent/refuse-cmc', () => {
    it('[VF01] accepts refuse with localizable reason', () => {
      expectValid('consent/refuse-cmc', {
        capabilityUrl: 'https://AbC@example.com/',
        reason: { en: 'Not at this time.' },
      });
    });

    it('[VF02] rejects refuse without capabilityUrl', () => {
      expectInvalid('consent/refuse-cmc', { reason: { en: 'no' } }, 'capabilityUrl');
    });
  });

  describe('[CMCVAL-REV] consent/revoke-cmc', () => {
    it('[VRK01] accepts revoke with accessId', () => {
      expectValid('consent/revoke-cmc', { accessId: 'abc123' });
    });

    it('[VRK02] rejects revoke without accessId', () => {
      expectInvalid('consent/revoke-cmc', {}, 'accessId');
    });
  });

  describe('[CMCVAL-CHA] message/chat-cmc', () => {
    it('[VC01] accepts short chat message', () => {
      expectValid('message/chat-cmc', { content: 'Hello!' });
    });

    it('[VC02] rejects empty content', () => {
      expectInvalid('message/chat-cmc', { content: '' }, 'content');
    });

    it('[VC03] rejects > 10 KB content', () => {
      const big = 'x'.repeat(10 * 1024 + 1);
      expectInvalid('message/chat-cmc', { content: big }, '10 KB');
    });
  });

  describe('[CMCVAL-SYS] notification/alert-cmc + notification/ack-cmc', () => {
    it('[VS01] accepts info alert with ackRequired', () => {
      expectValid('notification/alert-cmc', {
        level: 'info',
        title: { en: 'Daily check-in' },
        body: { en: 'Complete today\'s questionnaire.' },
        ackRequired: true,
        ackId: 'daily-2026-05-13',
      });
    });

    it('[VS02] rejects alert with invalid level', () => {
      expectInvalid(
        'notification/alert-cmc',
        { level: 'urgent', title: { en: 'x' }, body: { en: 'x' } },
        'level'
      );
    });

    it('[VS03] accepts ack with alertEventId + ackId', () => {
      expectValid('notification/ack-cmc', { alertEventId: 'evt123', ackId: 'daily-2026-05-13' });
    });

    it('[VS04] rejects ack missing ackId', () => {
      expectInvalid('notification/ack-cmc', { alertEventId: 'evt123' }, 'ackId');
    });
  });

  describe('[CMCVAL-SCO] system-scope-request + system-scope-update', () => {
    it('[VC04] accepts scope-request with newPermissions + message', () => {
      expectValid('consent/scope-request-cmc', {
        newPermissions: [{ streamId: 'nutrition', level: 'read' }],
        message: { en: 'Could I also see your nutrition log?' },
      });
    });

    it('[VC05] rejects scope-request with empty permissions array', () => {
      expectInvalid(
        'consent/scope-request-cmc',
        { newPermissions: [] },
        'newPermissions'
      );
    });

    it('[VC06] accepts scope-update as response (scopeRequestEventId + accept)', () => {
      expectValid('consent/scope-update-cmc', {
        scopeRequestEventId: 'evt-req-123',
        accept: true,
      });
    });

    it('[VC07] accepts scope-update as self-initiated (newPermissions only)', () => {
      expectValid('consent/scope-update-cmc', {
        newPermissions: [{ streamId: 'sleep', level: 'read' }],
      });
    });

    it('[VC08] rejects scope-update with neither request-ref nor newPermissions', () => {
      expectInvalid('consent/scope-update-cmc', { accept: true }, 'scopeRequestEventId');
    });
  });
});
