/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * This core's switch over the platform-wide configuration held in the
 * platform store, read from the core's own files only (never from the store):
 *
 *   platform.configStore.ignore     PER-CORE  true: the core loads no value from the store (false)
 *   platform.configStore.localOnly  PER-CORE  configuration keys the core always takes from its files ([])
 *
 * Read by `describeAdminConfig` (boot validation and `bin/check-config.js`).
 * Not acted on in this release: the validator reports no problem.
 */

type ConfigReader = { get: (key: string) => unknown };

export type ConfigStoreReport = { problems: Array<{ message: string; path: string[] }>; warnings: string[] };

/** Problems (the boot refuses them) and warnings of `platform.configStore`. */
export function describeConfigStore (_config: ConfigReader): ConfigStoreReport {
  return { problems: [], warnings: [] };
}
