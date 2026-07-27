/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in (OIDC relying party) — route mount + host wiring.
 *
 * Builds the deps the `sso` component needs from the app and hands them to
 * `registerRoutes`. The component soft-degrades to a no-op when SSO is
 * disabled (the default) or no provider is configured, so this mount is inert
 * on a stock deployment. Later changes extend the injected deps (account
 * resolution, session mint, sub-binding persistence, audit) as the flow lands.
 */

import type { AppLike } from './_types.ts';
import { registerRoutes } from 'sso';

type ExpressApp = { get: (...args: unknown[]) => void };

export default function mountSso (expressApp: ExpressApp, app: AppLike): void {
  registerRoutes(expressApp, { config: app.config });
}
