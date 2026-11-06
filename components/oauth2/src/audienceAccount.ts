/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: a per-user audience bound to the signed-in account.
 *
 * `/oauth2/authorize` accepts a value that instantiates a per-user audience of
 * the client (`https://alice.example.com/...` for
 * `https://{username}.example.com/...`) on its shape alone: no user is known
 * there, and `login_hint` is never trusted for it. Where the user is known
 * (the signed-in `/oauth2/authorize/offer`, `/oauth2/authorize/accept`, and
 * the token exchange on the home core), the label must name that account: a
 * label the platform routes itself (a service host, a core id, a static
 * entry, a hosted site, an issuer label) never does, whoever holds the name;
 * otherwise it must be the account's current username or one of its address
 * aliases. One refusal for every other label, so it tells nothing about
 * whether an account exists.
 */

import type { OAuthClient } from './storage.ts';
import { matchAudience, withinResourceCap } from './resourceIndicator.ts';
import { audit } from './audit.ts';

/** The refusal reason (answer and audit), for every label that does not name the account. */
export const AUDIENCE_ACCOUNT_MISMATCH = 'audience-account-mismatch';

/** The refusal's `error_description`. */
export const AUDIENCE_ACCOUNT_MISMATCH_TEXT = 'the requested resource names another account\'s address';

/** Whether the platform answers a host label itself (never an account's host). */
export type PlatformRoutedLabel = (label: string) => boolean;

/** The names an account is addressed by: its current username, and its address aliases. */
export type AccountNames = { username: string; addressAliases?: readonly string[] };

/**
 * Whether a per-user audience's label names this account. The platform's own
 * names are checked first: a legacy account that holds one gets no address
 * under it. Former usernames are not accepted (the address is the current
 * name). No predicate (a unit test) means no name is routed.
 */
export function labelNamesAccount (label: string, account: AccountNames, isPlatformRoutedLabel?: PlatformRoutedLabel | null): boolean {
  const l = label.toLowerCase();
  if (isPlatformRoutedLabel != null && isPlatformRoutedLabel(l)) return false;
  if (typeof account.username === 'string' && account.username.toLowerCase() === l) return true;
  return (account.addressAliases ?? []).some((a) => typeof a === 'string' && a.toLowerCase() === l);
}

/**
 * A consent's audience against the signed-in account: null when it may go
 * on (no audience, a client without a list, an exact audience, or a per-user
 * one naming the account), `'mismatch'` when a per-user audience names
 * another address, `'unlisted'` when the client's list no longer holds the
 * audience the authorization named (changed since `/oauth2/authorize`).
 */
export function consentAudienceRefusal (
  audience: string | undefined,
  client: OAuthClient | null,
  account: AccountNames,
  isPlatformRoutedLabel?: PlatformRoutedLabel | null
): null | 'mismatch' | 'unlisted' {
  if (audience == null || client == null) return null;
  const list = Array.isArray(client.allowedAudiences) && client.allowedAudiences.length > 0 ? client.allowedAudiences : null;
  if (list == null) return null;
  const match = withinResourceCap(audience, list) ? matchAudience(audience, list) : null;
  if (match == null) return 'unlisted';
  if (match.label == null) return null;
  return labelNamesAccount(match.label, account, isPlatformRoutedLabel) ? null : 'mismatch';
}

/** The audit row of a consent refused by `consentAudienceRefusal` (no username, no label). */
export async function auditAudienceRefusal (payload: { clientId: string; scope: string[] }, kind: 'mismatch' | 'unlisted'): Promise<void> {
  await audit('oauth.consent.refused', {
    clientId: payload.clientId,
    requestedScope: payload.scope,
    reason: kind === 'mismatch' ? AUDIENCE_ACCOUNT_MISMATCH : 'audience-not-listed',
  });
}

/** The answer of a consent refused by `consentAudienceRefusal`. */
export function consentAudienceAnswer (kind: 'mismatch' | 'unlisted'): { status: number; body: { error: string; error_description: string; reason?: string } } {
  if (kind === 'mismatch') {
    return { status: 403, body: { error: 'access_denied', error_description: AUDIENCE_ACCOUNT_MISMATCH_TEXT, reason: AUDIENCE_ACCOUNT_MISMATCH } };
  }
  return {
    status: 400,
    body: { error: 'invalid_target', error_description: 'the requested resource is no longer one this client may access: restart the authorization flow' },
  };
}
