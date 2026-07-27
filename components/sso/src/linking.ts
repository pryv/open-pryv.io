/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — identity → account resolution (the linking rule table).
 *
 * A validated IdP identity (`{ provider, sub, email, emailVerified }` — the
 * id_token already passed iss/aud/exp/nonce/state) is mapped to a Pryv account,
 * fail-closed, first match wins:
 *
 *   R3  email_verified !== true                      → refuse `sso-failed`
 *   R4  a (provider, sub) binding exists             → LOG IN that account
 *       - the `sub` is the stable id; the email claim is IGNORED here (IdP-side
 *         email changes / address recycling must not re-route an existing link).
 *         If the current email maps to a DIFFERENT account, warn — sub wins.
 *   R8  binding exists but its account is gone        → release it, re-evaluate
 *   R5  no binding; email resolves to U AND U proved  → LOG IN + persist binding
 *       ownership of that address (isProvedOwnership on the home core)
 *   R6  no binding; email resolves to U but NOT proved→ refuse `email-not-verified`
 *       (the account-takeover gate: a Pryv account that merely ASSERTED a
 *        victim's address, never proving it, must not receive that victim's
 *        IdP-asserted identity)
 *   R7  no binding; email resolves to nothing         → refuse `no-account`
 *       (v1 is sign-in only — no auto-provisioning)
 *
 * R1 (unknown provider) and R2 (bad state / id_token) are handled upstream in
 * the route handlers before this runs.
 *
 * The rule logic is pure and dependency-injected — the api-server binds the
 * real platform + `:_emails:` container reads; tests bind fakes to exercise
 * every row.
 */

/** The proven identity coming out of the callback handler. */
export type IdentityClaims = {
  provider: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
};

/** Coarse, browser-facing refusal codes (detail stays in the server log). */
export type RefuseCode = 'sso-failed' | 'email-not-verified' | 'no-account';

export type LinkOutcome =
  | { kind: 'login'; username: string }
  | { kind: 'refuse'; code: RefuseCode };

export type LinkDeps = {
  /** Resolve an existing (provider, sub) binding to a username, or null. */
  getBinding: (provider: string, sub: string) => Promise<string | null>;
  /** Persist a first-login (provider, sub) → username binding (idempotent). */
  setBinding: (provider: string, sub: string, username: string) => Promise<void>;
  /** Release a stale binding (its account is gone). Owner-guarded upstream. */
  releaseBinding: (provider: string, sub: string, username: string) => Promise<void>;
  /** Platform routing: which account holds this email, or null. */
  getUsernameByEmail: (email: string) => Promise<string | null>;
  /** Does this username still resolve to a live account? */
  userExists: (username: string) => Promise<boolean>;
  /** Has `username` PROVED ownership of `email` on its home core (R5/R6)? */
  isEmailProved: (username: string, email: string) => Promise<boolean>;
  logger?: { warn: (msg: string) => void };
};

/**
 * Apply the rule table to a validated identity. Never throws for a "no match"
 * outcome — it returns a refusal; only a dependency failure propagates.
 */
export async function resolveAccountForIdentity (deps: LinkDeps, claims: IdentityClaims): Promise<LinkOutcome> {
  // R3 — the IdP must assert inbox control; without it, email matching is
  // meaningless. No operator override.
  if (claims.emailVerified !== true) return { kind: 'refuse', code: 'sso-failed' };

  // R4 — an existing (provider, sub) binding wins on the stable id.
  let bound = await deps.getBinding(claims.provider, claims.sub);
  if (bound != null) {
    if (await deps.userExists(bound)) {
      if (claims.email != null) {
        const byEmail = await deps.getUsernameByEmail(claims.email);
        if (byEmail != null && byEmail !== bound) {
          // Divergence: sub is bound to one account, the email now proves on
          // another. sub wins; surface it for operator forensics (no ids).
          deps.logger?.warn(`[sso] provider "${claims.provider}": bound account differs from the current email claim's account — sub wins`);
        }
      }
      return { kind: 'login', username: bound };
    }
    // R8 — the bound account is gone: release the stale row and fall through.
    await deps.releaseBinding(claims.provider, claims.sub, bound);
    bound = null;
  }

  // R5 / R6 / R7 — resolve by email.
  if (claims.email == null) return { kind: 'refuse', code: 'no-account' };
  const username = await deps.getUsernameByEmail(claims.email);
  if (username == null) return { kind: 'refuse', code: 'no-account' }; // R7

  const proved = await deps.isEmailProved(username, claims.email);
  if (!proved) return { kind: 'refuse', code: 'email-not-verified' }; // R6

  // R5 — proved ownership: link first, then log in. setBinding is idempotent,
  // so a race that double-links the same (provider, sub, username) is harmless.
  await deps.setBinding(claims.provider, claims.sub, username);
  return { kind: 'login', username };
}
