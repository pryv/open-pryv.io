/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Shared deps builder for the create-from-delegate account-provisioning path.
 *
 * The target core needs to claim a username platform-wide and create a user
 * through the business repository path, with an OPTIONAL email and an OPTIONAL
 * password (a random unguessable hash when omitted, so the account is reachable
 * only through its delegates until one sets a real password). It must NOT reuse
 * the register / system.createUser params schema — that schema force-appends
 * `email` to `required` (isRequiredInValidation account streams). Instead we
 * build the User and call `repository.insertOne` directly; the domain layer
 * already tolerates a null email.
 *
 * Both the same-core fast path (methods/delegations.ts) and the cross-core
 * system route (routes/system.ts) inject the same provisionAccount/rollbackAccount
 * pair, so the provisioning + rollback semantics stay in one place.
 */

const crypto = require('crypto');
const { getUsersRepository } = require('business/src/users/index.ts');
const { User } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');
const { buildMallForCmc } = require('./cmcMall.ts');
const { slug } = require('cmc');
const { ready, getLogger } = require('@pryv/boiler');

const logger = getLogger('delegations:accounts');

type ProvisionParams = {
  username: string;
  email?: string;
  password?: string;
  language?: string;
};

type ItemLike = { id?: string; data?: { id?: string }; message?: string };

/** True when a storage error signals a username / unique-field already exists. */
function isAlreadyExists (err: unknown): boolean {
  const e = err as ItemLike;
  const id = e?.id || e?.data?.id;
  if (id === 'item-already-exists' || id === 'duplicate') return true;
  const msg = String(e?.message || err).toLowerCase();
  return msg.includes('already exists') || msg.includes('duplicate');
}

/** A random, unguessable password — the passwordless-account marker. */
function randomPassword (): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Build the { mall, now, self, provisionAccount, rollbackAccount } deps for
 * delegation.handleSystemCreateAccount on THIS core.
 */
export async function buildSystemCreateAccountDeps (): Promise<{
  mall: unknown;
  now: () => number;
  self: { host: string; hostSlug: string };
  provisionAccount: (params: ProvisionParams) => Promise<{ userId: string }>;
  rollbackAccount: (username: string, userId: string) => Promise<void>;
}> {
  const config = await ready();
  const mall = await buildMallForCmc();
  const usersRepository = await getUsersRepository();
  const platform = await getPlatform();
  const delegation = require('delegation');
  const DelegationErrorIds = delegation.errorIds.DelegationErrorIds;
  const delegationError = delegation.attach.delegationError;

  const host = selfHost(config);
  const self = { host, hostSlug: slug.slugifyHost(host) };

  async function provisionAccount (params: ProvisionParams): Promise<{ userId: string }> {
    const username = String(params.username || '').trim();
    if (username.length === 0) {
      throw delegationError(DelegationErrorIds.CREATION_FAILED, 'A username for the new account is required', 400);
    }
    // Claim the username platform-wide FIRST — the atomic cross-core collision
    // gate (mirrors the registration write order). insertOne's local guard is
    // per-core only, so without this a name hosted on another core would slip
    // through. Single-core also claims a user-core row (registration does too).
    const claimed = await platform.setUserCoreIfNotExists(username, platform.coreId);
    if (!claimed) {
      throw delegationError(DelegationErrorIds.USERNAME_TAKEN,
        'The requested username is already taken', 409, { username });
    }
    try {
      const effectivePassword = (typeof params.password === 'string' && params.password.length > 0)
        ? params.password
        : randomPassword();
      const newUser = new User({
        username,
        email: params.email,
        language: params.language,
        password: effectivePassword,
      });
      // withSession=false: no login session / personal access is created — the
      // account is reachable only through its delegates until a real login.
      await usersRepository.insertOne(newUser, false);
      return { userId: newUser.id };
    } catch (err) {
      // insertOne's own compensateFailedInsert already releases the user-core
      // claim when no local user owns the name; release defensively in case the
      // failure happened before that path ran.
      try {
        if (!(await usersRepository.usernameExists(username))) {
          await platform.deleteUserCore(username);
        }
      } catch (_e) { /* best-effort */ }
      if (isAlreadyExists(err)) {
        throw delegationError(DelegationErrorIds.USERNAME_TAKEN,
          'The requested username is already taken', 409, { username });
      }
      throw delegationError(DelegationErrorIds.CREATION_FAILED,
        'Could not create the delegated account', 502,
        { cause: err instanceof Error ? err.message : String(err) });
    }
  }

  async function rollbackAccount (username: string, userId: string): Promise<void> {
    // Full cascading delete of the freshly-created account: releases the
    // platform unique fields (username, email) + the user-core routing row +
    // the user's data. Used when a post-creation step (anchor / control mint)
    // fails after the account already exists.
    try {
      await usersRepository.deleteOne(userId, username);
    } catch (err) {
      logger.warn('delegated-account rollback failed for "' + username + '"',
        err instanceof Error ? err.message : String(err));
    }
  }

  return { mall, now: nowSeconds, self, provisionAccount, rollbackAccount };
}

function nowSeconds (): number { return Math.floor(Date.now() / 1000); }

function selfHost (config: { get: (k: string) => unknown }): string {
  let host = config.get('dns:domain') as string | undefined;
  if (host == null || host === '') {
    const apiUrl = (config.get('service:api') || config.get('service:register')) as string | undefined;
    if (typeof apiUrl === 'string' && apiUrl.length > 0) {
      try { host = new URL(apiUrl.replace('{username}', 'x')).host; } catch (_e) { /* fallthrough */ }
    }
  }
  if (host == null || host === '') host = 'localhost';
  return host;
}
