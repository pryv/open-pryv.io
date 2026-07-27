/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SSO account-linking deps over the real platform + `:_emails:` container.
 *
 * Adapts the platform + users-repository + container primitives to the
 * `LinkDeps` seam the `sso` rule engine (`resolveAccountForIdentity`) consumes.
 * Extracted from the route mount so it can be exercised against a real booted
 * core (see the `[SSOLI]` integration test), not only through the HTTP flow.
 */

import type { LinkDeps } from 'sso';
import { getRawEvents } from 'business/src/emails/container.ts';
import { isProvedOwnership } from 'business/src/emails/constants.ts';

/** Normalize an email for comparison the way HASHED-mode platform routing does
 *  (lowercase + trim), so a case-differing IdP claim that still ROUTED to the
 *  account also passes the proof check. (In cleartext mode the platform email
 *  lookup is byte-exact, so a case-differing claim misses at routing — a
 *  platform-level trait, not resolved here.) */
function normalizeEmail (email: string): string {
  return email.trim().toLowerCase();
}

/** Platform field name that holds a provider's `sub` bindings. */
export const bindingField = (provider: string): string => `sso-${provider}`;

/** The platform surface this adapter needs (structural subset of Platform). */
type PlatformLike = {
  getUsersUniqueField: (field: string, value: string) => Promise<string | null>;
  resolveLocalUsernameFromToken: (token: string) => Promise<string | null>;
  reserveUserUniqueValue: (username: string, field: string, value: string) => Promise<boolean>;
  releaseUserUniqueValue: (username: string, field: string, value: string) => Promise<boolean>;
};

type UsersRepositoryLike = {
  getUserIdForUsername: (username: string) => Promise<string | null>;
};

export function buildSsoLinkDeps (
  platform: PlatformLike,
  usersRepository: UsersRepositoryLike,
  logger?: { warn: (msg: string) => void }
): LinkDeps {
  // getUsersUniqueField returns the HMAC username TOKEN in hashed piiMode;
  // resolveLocalUsernameFromToken turns it back into a cleartext username (and
  // is a no-op in cleartext mode). v1 SSO is single-core (config forbids
  // dns.active), so no cross-core redirect is needed.
  async function resolveUsername (field: string, value: string): Promise<string | null> {
    const tokenOrName = await platform.getUsersUniqueField(field, value);
    if (tokenOrName == null) return null;
    return await platform.resolveLocalUsernameFromToken(tokenOrName);
  }

  return {
    // In hashed piiMode a binding to a DELETED user resolves to null here
    // (its token is no longer in the local users_index) — so the rule engine
    // reads it as "no binding" and falls through to email re-resolution rather
    // than reaching R8. That fails SAFE (a stale binding never routes a login
    // to the wrong account). The user-delete sweep already releases the user's
    // `sso-*` rows, so a truly orphaned row is the rare defensive case; R8's
    // explicit release still fires in cleartext mode where the name survives.
    getBinding: (provider, sub) => resolveUsername(bindingField(provider), sub),
    setBinding: async (provider, sub, username) => {
      const ok = await platform.reserveUserUniqueValue(username, bindingField(provider), sub);
      if (!ok) {
        // The (provider, sub) row is already owned by a DIFFERENT username token
        // (a stale binding of a deleted user, or a prior link) — the new link is
        // not persisted, so a later R4 could still route to the other account.
        // Surface it for operator cleanup (platformCheckIntegrity's orphan pass
        // flags a truly stale row too). No identifiers in the log.
        logger?.warn(`[sso] binding reservation refused for provider "${provider}" — the IdP subject is already bound to a different account`);
      }
    },
    releaseBinding: async (provider, sub, username) => {
      await platform.releaseUserUniqueValue(username, bindingField(provider), sub);
    },
    getUsernameByEmail: (email) => resolveUsername('email', email),
    userExists: async (username) => (await usersRepository.getUserIdForUsername(username)) != null,
    isEmailProved: async (username, email) => {
      const userId = await usersRepository.getUserIdForUsername(username);
      if (userId == null) return false;
      const target = normalizeEmail(email);
      // A LIVE (non-trashed), case-insensitively matching, PROVED entry.
      // Case-insensitive so an IdP email whose case differs from the stored one
      // still verifies; trashed events are excluded so a removed-but-not-yet-
      // released address cannot pass the gate.
      const events = await getRawEvents(userId);
      return events.some((ev) =>
        (ev as { trashed?: boolean }).trashed !== true &&
        typeof ev.content.value === 'string' &&
        normalizeEmail(ev.content.value) === target &&
        isProvedOwnership(ev.content));
    },
    logger
  };
}
