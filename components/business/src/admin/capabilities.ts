/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * What this core offers to the administration portal: a fixed, in-code list
 * of capabilities (a portal module declares the ones it needs and is hidden
 * when one is missing). A capability is named like the first part of the
 * permissions that act on it (`users` for `users:read`). The list is part of
 * the portal contract: names are added, never renamed.
 *
 * Gating is presentation only: every route still checks its permission.
 */

type ConfigReader = { get: (key: string) => unknown };

type CapabilityDef = { name: string; offered?: (config: ConfigReader) => boolean };

const CAPABILITIES: readonly CapabilityDef[] = Object.freeze([
  { name: 'setup' },
  { name: 'roles' },
  { name: 'claimCodes' },
  { name: 'users' },
  { name: 'invitations' },
  { name: 'cores' },
  { name: 'config' },
  { name: 'configEffective' },
  { name: 'certs', offered: (c) => c.get('letsEncrypt:enabled') === true },
  { name: 'dns', offered: (c) => c.get('dns:active') === true },
  { name: 'mail', offered: (c) => c.get('services:email:method') === 'in-process' },
  { name: 'observability' },
  { name: 'migrations' },
  { name: 'integrity' },
  { name: 'audit', offered: (c) => c.get('audit:active') !== false },
  { name: 'erasures' },
  { name: 'extId' },
  { name: 'autoDeletion' },
  { name: 'delegation', offered: (c) => c.get('delegation:active') !== false },
  { name: 'oauthClients' },
  { name: 'publishers' },
  { name: 'bootstrap' }
]);

/** Every capability name this release knows. */
export const CAPABILITY_NAMES: readonly string[] = Object.freeze(CAPABILITIES.map((c) => c.name));

/**
 * The capabilities this core offers with its configuration: the built-in ones
 * it offers, then the platform's own (`portal.customCapabilities`).
 */
export function offeredCapabilities (config: ConfigReader): string[] {
  const builtIn = CAPABILITIES.filter((c) => c.offered == null || c.offered(config)).map((c) => c.name);
  return [...builtIn, ...customCapabilities(config)];
}

export type CustomCapabilitiesReport = { problems: Array<{ message: string; path: string[] }>; warnings: string[] };

/**
 * The capability names of `portal.customCapabilities`, offered to the
 * platform's own portal modules. None in this release: the key is not read.
 */
export function customCapabilities (_config: ConfigReader): string[] {
  return [];
}

/**
 * Problems (the boot refuses them) and warnings of `portal.customCapabilities`
 * (read by `describeAdminConfig`). Nothing is checked in this release.
 */
export function describeCustomCapabilities (_config: ConfigReader): CustomCapabilitiesReport {
  return { problems: [], warnings: [] };
}
