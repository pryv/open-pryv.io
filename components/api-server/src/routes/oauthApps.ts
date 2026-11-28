/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account routes of the developer space (per-user routes: mounted with the
 * other account routes). See methods/oauthApps.ts.
 *
 * Mounts nothing in this release.
 */

import type { AppLike } from './_types.ts';
import type { Application as ExpressApp } from 'express';

export default function (_expressApp: ExpressApp, _app: AppLike): void {
  // no route yet
}
