/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — Pryv as an OpenID Connect relying party.
 *
 * The host app mounts this component next to the OAuth2 provider routes. It
 * soft-degrades to a no-op when the feature is disabled (the default) or no
 * provider is configured, so a stock deployment boots unchanged and exposes
 * nothing. See `routes.ts` for the mount seam.
 */

export { registerRoutes } from './routes.ts';
export type { SsoDeps } from './routes.ts';
export type { IdentityClaims } from './routes/callback.ts';
export { createRegistry, readProviders } from './providers.ts';
export type { ProviderDef, ProviderPublic, Registry } from './providers.ts';
export { resolveAccountForIdentity } from './linking.ts';
export type { LinkDeps, LinkOutcome, RefuseCode } from './linking.ts';
