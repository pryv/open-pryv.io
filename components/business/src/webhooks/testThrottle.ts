/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `webhooks.test` calls the receiver right away. It follows the webhook's
 * own delivery throttle (`minIntervalMs`): one test call per interval per
 * webhook, on every API worker and core of the platform (PlatformDB's
 * cluster-wide TTL store, atomic set-if-absent).
 */

import * as storages from 'storages';

type StateRow = { value: unknown; expiresAt: number };
type ThrottleStore = {
  setAccessStateIfAbsent: (key: string, value: unknown, expiresAt: number) => Promise<boolean>;
  getAccessState: (key: string) => Promise<StateRow | null>;
};

const DEFAULT_MIN_INTERVAL_MS = 5000;

function testSlotKey (userId: string, webhookId: string): string {
  return 'webhook-test/' + userId + '/' + webhookId;
}

/**
 * Reserve a test call of this webhook. Returns null when the call may go,
 * or the number of seconds to wait before the next one.
 */
async function reserveWebhookTestCall (userId: string, webhookId: string, minIntervalMs: number | null | undefined): Promise<number | null> {
  const db = storages.platformDB as unknown as ThrottleStore | undefined;
  if (db == null || typeof db.setAccessStateIfAbsent !== 'function') {
    throw new Error('webhook test throttle: PlatformDB is not initialised');
  }
  const interval = (typeof minIntervalMs === 'number' && minIntervalMs > 0) ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
  const now = Date.now();
  const key = testSlotKey(userId, webhookId);
  if (await db.setAccessStateIfAbsent(key, { at: now }, now + interval)) return null;
  const row = await db.getAccessState(key);
  // Expired between the two reads: the next call gets through.
  if (row == null) return 1;
  return Math.max(1, Math.ceil((row.expiresAt - now) / 1000));
}

export { reserveWebhookTestCall, testSlotKey };
