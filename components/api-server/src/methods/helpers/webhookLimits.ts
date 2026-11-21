/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bounds on webhooks:
 *
 * - `webhooks.maxPerAccess`: webhooks one access may hold;
 * - `webhooks.maxPerUser`: webhooks one account may hold, all accesses together;
 * - `webhooks.maxScopes`: scopes one webhook may carry.
 *
 * Every change of an account's data reaches each of its matching webhooks
 * (one outbound call per webhook and `minIntervalMs`, and a stored run), and
 * each scope is prepared with its expanded stream subtree, so an unbounded
 * number makes the core send and store as much as a token asks. A cap refuses
 * the new webhook or scope set; webhooks already stored keep working. 0 turns
 * a cap off. Soft limits: creates running at once can pass a cap by a few.
 */

const WEBHOOK_LIMIT_DEFAULTS = Object.freeze({
  maxPerAccess: 10,
  maxPerUser: 100,
  maxScopes: 20
});

type WebhookLimits = { maxPerAccess: number; maxPerUser: number; maxScopes: number };

function countOr (value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : fallback;
}

/** The limits to apply, from the `webhooks` config block (defaults when absent or invalid). */
function readWebhookLimits (get: (key: string) => unknown): WebhookLimits {
  return {
    maxPerAccess: countOr(get('webhooks:maxPerAccess'), WEBHOOK_LIMIT_DEFAULTS.maxPerAccess),
    maxPerUser: countOr(get('webhooks:maxPerUser'), WEBHOOK_LIMIT_DEFAULTS.maxPerUser),
    maxScopes: countOr(get('webhooks:maxScopes'), WEBHOOK_LIMIT_DEFAULTS.maxScopes)
  };
}

/**
 * Why one more webhook would pass a count cap, given the account's webhooks
 * and the access creating it; null when it would not.
 */
function webhookCountProblem (limits: WebhookLimits, webhooks: Array<{ accessId: string }>, accessId: string): string | null {
  if (limits.maxPerUser > 0 && webhooks.length >= limits.maxPerUser) {
    return `the account already has ${webhooks.length} webhooks, the most allowed is ${limits.maxPerUser} (webhooks.maxPerUser)`;
  }
  const ofAccess = webhooks.filter((w) => w.accessId === accessId).length;
  if (limits.maxPerAccess > 0 && ofAccess >= limits.maxPerAccess) {
    return `this access already has ${ofAccess} webhooks, the most allowed is ${limits.maxPerAccess} (webhooks.maxPerAccess)`;
  }
  return null;
}

/** Why a scope set is too large; null when it is not (or is no object). */
function webhookScopesProblem (limits: WebhookLimits, scopes: unknown): string | null {
  if (limits.maxScopes <= 0 || scopes == null || typeof scopes !== 'object') return null;
  const count = Object.keys(scopes).length;
  if (count <= limits.maxScopes) return null;
  return `a webhook may have at most ${limits.maxScopes} scopes, ${count} given (webhooks.maxScopes)`;
}

export { WEBHOOK_LIMIT_DEFAULTS, readWebhookLimits, webhookCountProblem, webhookScopesProblem };
export type { WebhookLimits };
