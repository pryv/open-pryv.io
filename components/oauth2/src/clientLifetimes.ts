/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: token lifetimes of a client.
 *
 * The `oauth:accessTokenTTL`, `oauth:refreshTokenTTL` and
 * `oauth:refreshTokenAbsoluteTTL` settings are the platform's lifetimes AND
 * caps. A client row may carry shorter ones (`accessTokenTTL`,
 * `refreshTokenTTL`, `refreshTokenAbsoluteTTL`, seconds): a value above the
 * cap is clamped to it, so an operator lowering a cap lowers every client.
 * `offlineAccessAllowed: false` withholds refresh tokens from the client.
 */

type ClientLifetimeFields = {
  accessTokenTTL?: unknown;
  refreshTokenTTL?: unknown;
  refreshTokenAbsoluteTTL?: unknown;
  offlineAccessAllowed?: unknown;
} | null | undefined;

export type Lifetimes = { accessTokenTTL: number; refreshTokenTTL: number; refreshTokenAbsoluteTTL: number };

/** The platform lifetimes (seconds), from the config. */
export function platformLifetimes (config: { get (key: string): unknown }): Lifetimes {
  return {
    accessTokenTTL: Number(config.get('oauth:accessTokenTTL') ?? 3600),
    refreshTokenTTL: Number(config.get('oauth:refreshTokenTTL') ?? 30 * 24 * 3600),
    refreshTokenAbsoluteTTL: Number(config.get('oauth:refreshTokenAbsoluteTTL') ?? 90 * 24 * 3600),
  };
}

/** A lifetime field of a client row is usable: a positive integer (seconds). */
export function isLifetime (v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** The lifetimes (seconds) of this client's tokens: its own, clamped to the platform's. */
export function clientLifetimes (config: { get (key: string): unknown }, client: ClientLifetimeFields): Lifetimes {
  const caps = platformLifetimes(config);
  const pick = (own: unknown, cap: number): number => isLifetime(own) ? Math.min(own, cap) : cap;
  return {
    accessTokenTTL: pick(client?.accessTokenTTL, caps.accessTokenTTL),
    refreshTokenTTL: pick(client?.refreshTokenTTL, caps.refreshTokenTTL),
    refreshTokenAbsoluteTTL: pick(client?.refreshTokenAbsoluteTTL, caps.refreshTokenAbsoluteTTL),
  };
}

/** Whether refresh tokens may be issued to (and redeemed by) this client; default yes. */
export function offlineAccessAllowed (client: ClientLifetimeFields): boolean {
  return client?.offlineAccessAllowed !== false;
}
