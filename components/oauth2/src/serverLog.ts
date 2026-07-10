/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — server-side error logging helper.
 *
 * Internal failures (storage down, mint callback threw, …) are surfaced
 * to the client as a GENERIC `error_description` — the raw `err.message`
 * MUST NOT leak across the token/accept endpoints, as it can carry
 * stack-ish internals or account hints. The real error is recorded here
 * on the server trail instead.
 *
 * The shared boiler logger throws until the process initialises it, so
 * this helper resolves it lazily and falls back to `console.error` when
 * boiler is not up (e.g. isolated unit tests) — logging is best-effort
 * and never throws back into the request path.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function resolveLogger (): { error: (...args: unknown[]) => void } | null {
  try {
    const { getLogger } = require('@pryv/boiler');
    return getLogger('oauth2');
  } catch (_e) {
    return null;
  }
}

/**
 * Record an internal error on the server trail. Accepts the human
 * context string plus the raw error; neither reaches the client.
 */
export function logServerError (message: string, err: unknown): void {
  const logger = resolveLogger();
  if (logger != null) {
    try { logger.error(message, err); return; } catch (_e) { /* fall through */ }
  }
  // eslint-disable-next-line no-console
  console.error('[oauth2] ' + message, err);
}
