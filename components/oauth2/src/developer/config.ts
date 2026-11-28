/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Settings of the developer space (applications registered by accounts in
 * `oauth.clientRegistration.mode: delegated`):
 *
 *   oauth.developerTerms             PLATFORM-WIDE  { url, version } of the terms a developer accepts (null: none)
 *   oauth.clientRegistration.limits  PLATFORM-WIDE  { appsPerAccount, creationsPerDay }
 *
 * Read by the boot validation (config/plugins/config-validation.js),
 * `bin/check-config.js` and the public portal settings
 * (`GET /system/portal/settings`).
 *
 * Nothing is checked nor published in this release: the validator reports
 * no problem and the portal settings gain no field.
 */

type ConfigReader = { get: (key: string) => unknown };

export type DeveloperConfigReport = { problems: Array<{ message: string; path: string[] }>; warnings: string[] };

/** Problems (the boot refuses them) and warnings of the developer space settings. */
export function describeDeveloperConfig (_config: ConfigReader): DeveloperConfigReport {
  return { problems: [], warnings: [] };
}

/** Fields the developer space adds to the public portal settings (none in this release). */
export function developerView (_config: ConfigReader): Record<string, unknown> {
  return {};
}
