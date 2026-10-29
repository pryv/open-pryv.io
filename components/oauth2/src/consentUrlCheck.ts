/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the `oauth.consentUrl` configuration check, shared by the boot
 * warning (bin/master.js) and bin/check-config.js.
 *
 * `GET /oauth2/authorize` redirects the user to this consent page and answers
 * 500 (server_error) while it is empty. OAuth has no enable flag: its routes
 * mount whenever an issuer can be derived (see issuer.ts), so an empty value
 * is reported then, as a warning only, since a deployment that does not use
 * the authorization flow runs fine without it. With no issuer the routes are
 * not mounted and there is nothing to report.
 */

import { issuerFromConfig } from './issuer.ts';

export const CONSENT_URL_WARNING = 'oauth.consentUrl is not set: GET /oauth2/authorize answers 500 (server_error) ' +
  'until it is, so no OAuth client can complete the authorization flow. Set it to the OAuth consent page of ' +
  'your auth UI (with app-web-user-account: its base URL followed by /oauth2-authorize).';

/** True when `value` holds a usable consent URL (a non-blank string). */
export function isConsentUrlSet (value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The warning to log at boot, or null when the consent URL is set or the
 * OAuth routes are not mounted (no issuer).
 */
export function consentUrlWarning (config: { get (key: string): unknown }): string | null {
  if (!issuerFromConfig(config)) return null;
  return isConsentUrlSet(config.get('oauth:consentUrl')) ? null : CONSENT_URL_WARNING;
}
