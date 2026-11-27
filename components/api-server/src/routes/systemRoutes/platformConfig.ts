/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { SystemRouteEntry } from './common.ts';

/**
 * Route table entries of the platform-wide configuration held in the
 * platform store, served by `../system-admin-config.ts`.
 */
export const PLATFORM_CONFIG_ROUTES: readonly SystemRouteEntry[] = Object.freeze([] as SystemRouteEntry[]);
