/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ConfigLike } from '@pryv/boiler';
import { normalizeAutoDeletionConfig } from 'business/src/autoDeletion/config.ts';
import type { AutoDeletionConfig } from 'business/src/autoDeletion/config.ts';
import { resolveLinkKey, resolveIdentityKey } from 'business/src/autoDeletion/state.ts';
import { describeMailCapability } from 'business/src/emails/mailCapability.ts';

/**
 * What a holder may set for the auto-deletion of their account on this core,
 * read from the live config (`service.info` and the account methods agree).
 */

export function autoDeletionConfig (config: ConfigLike): AutoDeletionConfig {
  return normalizeAutoDeletionConfig(config.get('account:autoDeletion'));
}

/**
 * Actions a holder may choose: `delete` only where the holder may delete the
 * account themselves (`user-account.delete` lists `personalToken`): nobody
 * schedules what they could not do directly. `transfer` where the core can
 * run one (`transferAvailable`).
 */
export function availableActions (config: ConfigLike): string[] {
  const actions: string[] = [];
  const canDelete = config.get('user-account:delete');
  if (Array.isArray(canDelete) && canDelete.includes('personalToken')) actions.push('delete');
  if (transferAvailable(config)) actions.push('transfer');
  return actions;
}

/**
 * A transfer needs delegation (the beneficiary becomes the account's
 * controller), mail (the beneficiary is reached by mail only), the account
 * app (the claim and decline pages) and a key for the links.
 */
export function transferAvailable (config: ConfigLike): boolean {
  if (config.get('delegation:active') === false) return false;
  if (!describeMailCapability(config).ok) return false;
  // Without the claim mail no transfer can reach its beneficiary.
  if (!mailSwitchedOn(config, 'accountTransferClaim')) return false;
  const accountApp = config.get('service:account');
  if (typeof accountApp !== 'string' || accountApp === '') return false;
  return transferLinkKey(config) != null;
}

/** Whether the mail `kind` is switched on (`services.email.enabled`). */
export function mailSwitchedOn (config: ConfigLike, kind: string): boolean {
  const enabled = config.get('services:email:enabled');
  if (enabled === false) return false;
  return !(enabled != null && typeof enabled === 'object' && (enabled as Record<string, unknown>)[kind] === false);
}

/** Key of the transfer links (null: none can be made). */
export function transferLinkKey (config: ConfigLike): Buffer | null {
  return resolveLinkKey(autoDeletionConfig(config).transfer.identitySecretsKey, config.get('auth:adminAccessKey'));
}

/** Key of the beneficiary identity envelopes (null: none can be stored). */
export function transferIdentityKey (config: ConfigLike): Buffer | null {
  return resolveIdentityKey(autoDeletionConfig(config).transfer.identitySecretsKey, config.get('auth:adminAccessKey'));
}

/** Triggers offered: no inactivity without access tracking (it cannot be measured). */
export function availableTriggers (config: ConfigLike): string[] {
  return config.get('accessTracking:isActive') === false ? ['date'] : ['date', 'inactivity'];
}
