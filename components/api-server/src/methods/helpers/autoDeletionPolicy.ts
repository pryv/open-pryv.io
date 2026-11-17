/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ConfigLike } from '@pryv/boiler';
import { normalizeAutoDeletionConfig } from 'business/src/autoDeletion/config.ts';
import type { AutoDeletionConfig } from 'business/src/autoDeletion/config.ts';

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
 * schedules what they could not do directly.
 */
export function availableActions (config: ConfigLike): string[] {
  const canDelete = config.get('user-account:delete');
  return Array.isArray(canDelete) && canDelete.includes('personalToken') ? ['delete'] : [];
}

/** Triggers offered: no inactivity without access tracking (it cannot be measured). */
export function availableTriggers (config: ConfigLike): string[] {
  return config.get('accessTracking:isActive') === false ? ['date'] : ['date', 'inactivity'];
}
