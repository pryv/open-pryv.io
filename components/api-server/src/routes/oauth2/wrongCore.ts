/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The consent of a name this core does not serve: the account's core, when
 * the platform places it on another core with a usable URL, for the 421
 * `wrong_core` answer of `/oauth2/authorize/offer` and `/accept`. The
 * decision is `resolveUserCore`'s (the same the reg endpoints take); any
 * other outcome (single core, unknown name, this core, a lookup failure, a
 * core without a usable URL) keeps the uniform answer.
 */

import type { UserCorePlatform } from '../reg/userCore.ts';
import { resolveUserCore } from '../reg/userCore.ts';

export type WrongCore = { wrongCore: true; coreUrl: string };

export async function wrongCoreOf (
  username: string,
  deps: { platform?: UserCorePlatform } = {}
): Promise<WrongCore | null> {
  const r = await resolveUserCore(username, deps);
  return r.kind === 'remote' ? { wrongCore: true, coreUrl: r.coreUrl } : null;
}
