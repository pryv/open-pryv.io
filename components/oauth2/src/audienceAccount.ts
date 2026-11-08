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

/** The reason (answer and audit) of a consent whose audience the client's current list does not hold. */
export const AUDIENCE_NOT_LISTED = 'audience-not-listed';

/** The refusal's `error_description`. */
export const AUDIENCE_ACCOUNT_MISMATCH_TEXT = 'the requested resource names another account\'s address';

/** Whether the platform answers a host label itself (never an account's host). */
export type PlatformRoutedLabel = (label: string) => boolean;

/**
 * The names an account is addressed by: its current username, its address
 * aliases and, for the token exchange only, its former usernames the account
 * still holds (an authorization made before a rename keeps working there).
 */
export type AccountNames = { username: string; addressAliases?: readonly string[]; formerUsernames?: readonly string[] };

/** The names a consent may bind: never a former username (a new authorization uses the current address). */
export type ConsentAccountNames = { username: string; addressAliases?: readonly string[]; formerUsernames?: never };

/**
 * Whether a per-user audience's label names this account. The platform's own
 * names are checked first: a legacy account that holds one gets no address
 * under it. Then the current username, an address alias, and the former
 * usernames when given (the exchange's subject only). No predicate (a unit
 * test) means no name is routed.
 */
export function labelNamesAccount (label: string, account: AccountNames, isPlatformRoutedLabel?: PlatformRoutedLabel | null): boolean {
  const l = label.toLowerCase();
  if (isPlatformRoutedLabel != null && isPlatformRoutedLabel(l)) return false;
  if (typeof account.username === 'string' && account.username.toLowerCase() === l) return true;
  if ((account.addressAliases ?? []).some((a) => typeof a === 'string' && a.toLowerCase() === l)) return true;
  return (account.formerUsernames ?? []).some((a) => typeof a === 'string' && a.toLowerCase() === l);
}

/**
 * A consent's audience against the signed-in account: null when it may go
 * on (no audience, a client without a list, an exact audience, or a per-user
 * one naming the account), `'mismatch'` when a per-user audience names
 * another address, `'unlisted'` when the client's list no longer holds the
 * audience the authorization named (changed since `/oauth2/authorize`), or
 * the client row is gone: the label is re-derived from the current list, so a
 * list that no longer matches is refused rather than passed unbound.
 */
export function consentAudienceRefusal (
  audience: string | undefined,
  client: OAuthClient | null,
  account: ConsentAccountNames,
  isPlatformRoutedLabel?: PlatformRoutedLabel | null
): null | 'mismatch' | 'unlisted' {
  if (audience == null) return null;
  if (client == null) return 'unlisted';
  const list = Array.isArray(client.allowedAudiences) && client.allowedAudiences.length > 0 ? client.allowedAudiences : null;
  if (list == null) return null;
  const match = withinResourceCap(audience, list) ? matchAudience(audience, list) : null;
  if (match == null) return 'unlisted';
  if (match.label == null) return null;
  return labelNamesAccount(match.label, account, isPlatformRoutedLabel) ? null : 'mismatch';
}

/**
 * The address alias a consent's per-user audience names, when it names one
 * (not the username): the grant adopts it, so the app knows the account by
 * that name only, whatever the client's subject type. Null for no audience,
 * an exact one, a client without a list, or a label that is the username or
 * no address alias of the account. Run after `consentAudienceRefusal`.
 */
export function addressAliasOfAudience (
  audience: string | undefined,
  client: OAuthClient | null,
  account: ConsentAccountNames,
  isPlatformRoutedLabel?: PlatformRoutedLabel | null
): string | null {
  const l = perUserLabelOf(audience, client, isPlatformRoutedLabel);
  if (l == null) return null;
  if (typeof account.username === 'string' && account.username.toLowerCase() === l) return null;
  return (account.addressAliases ?? []).find((a) => typeof a === 'string' && a.toLowerCase() === l) ?? null;
}

/**
 * Whether a consent's per-user audience names the account's current
 * username (not an address alias, not an exact audience, not no audience).
 * A grant that adopted an address alias is then replaced: its tokens are
 * used at the alias only, so a session bound to the username's address
 * cannot be minted from it. Run after `consentAudienceRefusal`.
 */
export function audienceNamesUsername (
  audience: string | undefined,
  client: OAuthClient | null,
  account: ConsentAccountNames,
  isPlatformRoutedLabel?: PlatformRoutedLabel | null
): boolean {
  const l = perUserLabelOf(audience, client, isPlatformRoutedLabel);
  return l != null && typeof account.username === 'string' && account.username.toLowerCase() === l;
}

/**
 * A consent at a per-user issuer (`oauth:perUserIssuer`): the issuer's host is
 * an account's address, so only that account consents there. Null when it may
 * go on (no per-user issuer, or its label is the signed-in account's current
 * username, or the address alias this consent adopts), `'mismatch'`
 * otherwise. An address alias the consent does not adopt is refused too: the
 * app would get an address naming the account by another name than the one
 * it was started at (the alias's point is that the app knows that name only).
 */
export function issuerAccountRefusal (
  issuerLabel: string | null | undefined,
  account: ConsentAccountNames,
  adopted: string | null,
  isPlatformRoutedLabel?: PlatformRoutedLabel | null
): null | 'mismatch' {
  if (issuerLabel == null) return null;
  if (!labelNamesAccount(issuerLabel, account, isPlatformRoutedLabel)) return 'mismatch';
  const l = issuerLabel.toLowerCase();
  if (typeof account.username === 'string' && account.username.toLowerCase() === l) return null;
  return adopted != null && adopted.toLowerCase() === l ? null : 'mismatch';
}

/** The lowercased label of a per-user audience of the client, null for any other (or a platform-routed label). */
function perUserLabelOf (audience: string | undefined, client: OAuthClient | null, isPlatformRoutedLabel?: PlatformRoutedLabel | null): string | null {
  if (audience == null || client == null) return null;
  const list = Array.isArray(client.allowedAudiences) && client.allowedAudiences.length > 0 ? client.allowedAudiences : null;
  if (list == null) return null;
  const match = withinResourceCap(audience, list) ? matchAudience(audience, list) : null;
  if (match?.label == null) return null;
  const l = match.label.toLowerCase();
  if (isPlatformRoutedLabel != null && isPlatformRoutedLabel(l)) return null;
  return l;
}

/** The audit row of a consent refused by `consentAudienceRefusal` (no username, no label). */
export async function auditAudienceRefusal (payload: { clientId: string; scope: string[] }, kind: 'mismatch' | 'unlisted'): Promise<void> {
  await audit('oauth.consent.refused', {
    clientId: payload.clientId,
    requestedScope: payload.scope,
    reason: kind === 'mismatch' ? AUDIENCE_ACCOUNT_MISMATCH : AUDIENCE_NOT_LISTED,
  });
}

/** The answer of a consent refused by `consentAudienceRefusal`. */
export function consentAudienceAnswer (kind: 'mismatch' | 'unlisted'): { status: number; body: { error: string; error_description: string; reason?: string } } {
  if (kind === 'mismatch') {
    return { status: 403, body: { error: 'access_denied', error_description: AUDIENCE_ACCOUNT_MISMATCH_TEXT, reason: AUDIENCE_ACCOUNT_MISMATCH } };
  }
  return {
    status: 400,
    body: {
      error: 'invalid_target',
      error_description: 'the requested resource is no longer one this client may access: restart the authorization flow',
      reason: AUDIENCE_NOT_LISTED,
    },
  };
}
