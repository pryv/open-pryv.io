/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { hostedSiteNames } from '../hostedSites.ts';
import { isSha256Hex } from './codes.ts';
import { portalUrl as portalAddress, PORTAL_SPACES, PORTAL_CONTRACT } from './portalDefaults.ts';
import { describeLocalPolicy } from './localPolicy.ts';
import { describeLockdown } from './lockdown.ts';
import { describeCustomCapabilities } from './capabilities.ts';
import { describeConfigStore } from '../platformConfig/localSwitch.ts';

/**
 * Configuration of setup and administration:
 *
 *   portal.site                     PLATFORM-WIDE  hosted site serving the portal (null: none; the
 *                                                  install wizard names it PORTAL_DEFAULT_SITE, `admin`)
 *   portal.url                      PLATFORM-WIDE  address of a portal hosted outside the platform
 *                                                  (null; not with portal.site)
 *   portal.cors.allowedOrigins      PLATFORM-WIDE  extra origins of a portal hosted outside the platform
 *   portal.spaces                   PLATFORM-WIDE  portal spaces offered ([admin, developer])
 *   portal.modules.disabled         PLATFORM-WIDE  portal module ids switched off ([])
 *   portal.modules.order            PLATFORM-WIDE  portal module ids listed first, in this order ([])
 *   portal.customCapabilities       PLATFORM-WIDE  the platform's own capability names (validated by capabilities.ts)
 *   setup.codeTtlHours              PLATFORM-WIDE  lifetime of a setup code (24)
 *   setup.codeHash                  BOOTSTRAP      SHA-256 of an operator-supplied setup code (null)
 *   setup.printCode                 PER-CORE       print the setup code block at boot (true)
 *   setup.registrationWhilePending  PLATFORM-WIDE  closed | open (closed)
 *   auth.adminAccessKeyScope        PLATFORM-WIDE  full | break-glass (full)
 *   admin.session.ttlMinutes        PLATFORM-WIDE  admin session lifetime (60)
 *   admin.session.stepUpMinutes     PLATFORM-WIDE  age of the second factor accepted for a sensitive act (5)
 *   admin.session.requireMfa        PLATFORM-WIDE  administrators need MFA whenever the platform has it on (true)
 *   admin.localPolicy               PER-CORE       grants this core accepts (validated by localPolicy.ts)
 *   admin.lockdown                  PER-CORE       what this core locks (validated by lockdown.ts)
 *   platform.configStore            PER-CORE       this core's use of the platform store (validated by
 *                                                  ../platformConfig/localSwitch.ts)
 *
 * One validator for the boot-time config validation, `bin/check-config.js`
 * and the readers. Pure: reads the values it is given.
 */

type ConfigReader = { get: (key: string) => unknown };

export type AdminKeyScope = 'full' | 'break-glass';
export type RegistrationWhilePending = 'closed' | 'open';

export type AdminConfig = {
  portal: {
    site: string | null;
    url: string | null;
    allowedOrigins: string[];
    spaces: string[];
    modules: { disabled: string[]; order: string[] };
  };
  setup: { codeTtlMs: number; codeHash: string | null; printCode: boolean; registrationWhilePending: RegistrationWhilePending };
  adminAccessKeyScope: AdminKeyScope;
  session: { ttlMs: number; stepUpMs: number; requireMfa: boolean };
};

export type AdminConfigReport = { value: AdminConfig; problems: Array<{ message: string; path: string[] }>; warnings: string[] };

export const ADMIN_KEY_SCOPES: readonly AdminKeyScope[] = ['full', 'break-glass'];
export const REGISTRATION_WHILE_PENDING: readonly RegistrationWhilePending[] = ['closed', 'open'];

const DEFAULTS = Object.freeze({ codeTtlHours: 24, ttlMinutes: 60, stepUpMinutes: 5 });
const LIMITS = Object.freeze({ codeTtlHours: 24 * 30, ttlMinutes: 24 * 60, stepUpMinutes: 60 });

function asBoolean (v: unknown, fallback: boolean): boolean | undefined {
  if (v == null) return fallback;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

function asNumber (v: unknown, fallback: number): number | undefined {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** A portal module id: letters, digits, `.`, `_`, `-`, starting with a letter or digit. */
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** An absolute http(s) URL without credentials, query or fragment. */
function isPortalAddress (v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' &&
      u.search === '' && u.hash === '';
  } catch {
    return false;
  }
}

function isOrigin (v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v;
  } catch {
    return false;
  }
}

/** Validate and resolve the keys. Never throws; problems name their key path. */
export function describeAdminConfig (config: ConfigReader): AdminConfigReport {
  const problems: Array<{ message: string; path: string[] }> = [];
  const problem = (path: string, message: string) => problems.push({ message: `${path} ${message}`, path: path.split('.') });

  // portal.site
  let site: string | null = null;
  const rawSite = config.get('portal:site');
  if (rawSite != null && rawSite !== '') {
    if (typeof rawSite !== 'string') {
      problem('portal.site', 'must be the name of a hosted site, or null');
    } else if (!hostedSiteNames(config).includes(rawSite.toLowerCase())) {
      problem('portal.site', `names the hosted site '${rawSite}', which is not configured in hostedSites`);
    } else {
      site = rawSite.toLowerCase();
    }
  }

  // portal.cors.allowedOrigins
  const allowedOrigins: string[] = [];
  const rawOrigins = config.get('portal:cors:allowedOrigins');
  if (rawOrigins != null) {
    if (!Array.isArray(rawOrigins)) {
      problem('portal.cors.allowedOrigins', 'must be a list of origins (https://host[:port])');
    } else {
      for (const o of rawOrigins) {
        if (isOrigin(o)) allowedOrigins.push(o as string);
        else problem('portal.cors.allowedOrigins', `holds ${JSON.stringify(o)}, which is not an origin (scheme, host and optional port, no path)`);
      }
    }
  }

  // portal.url
  let url: string | null = null;
  const rawUrl = config.get('portal:url');
  if (rawUrl != null && rawUrl !== '') {
    if (!isPortalAddress(rawUrl)) {
      problem('portal.url', 'must be the absolute http(s) address of a portal hosted outside the platform (no credentials, query or fragment), or null');
    } else if (rawSite != null && rawSite !== '') {
      problem('portal.url', 'and portal.site are both set: portal.site names a portal served by the platform, portal.url one hosted outside it; keep one');
    } else {
      url = new URL(rawUrl).href; // one form for clients (lower-case host, a path)
    }
  }

  // portal.spaces
  let spaces: string[] = [...PORTAL_SPACES];
  const rawSpaces = config.get('portal:spaces');
  if (rawSpaces != null) {
    if (!Array.isArray(rawSpaces) || rawSpaces.length === 0 ||
        !rawSpaces.every((s) => typeof s === 'string' && PORTAL_SPACES.includes(s)) ||
        new Set(rawSpaces).size !== rawSpaces.length) {
      problem('portal.spaces', `must be a non-empty list of distinct portal spaces among: ${PORTAL_SPACES.join(', ')}`);
    } else {
      spaces = [...rawSpaces];
    }
  }

  // portal.modules.disabled, portal.modules.order
  const moduleIds = (key: 'disabled' | 'order'): string[] => {
    const raw = config.get('portal:modules:' + key);
    if (raw == null) return [];
    if (!Array.isArray(raw) || !raw.every((m) => typeof m === 'string' && MODULE_ID_RE.test(m))) {
      problem('portal.modules.' + key, 'must be a list of portal module ids (letters, digits, ".", "_" or "-")');
      return [];
    }
    return [...new Set(raw as string[])];
  };
  const modules = { disabled: moduleIds('disabled'), order: moduleIds('order') };

  // setup.*
  let ttlHours = asNumber(config.get('setup:codeTtlHours'), DEFAULTS.codeTtlHours);
  if (ttlHours == null || ttlHours <= 0 || ttlHours > LIMITS.codeTtlHours) {
    problem('setup.codeTtlHours', `must be a number of hours above 0 and at most ${LIMITS.codeTtlHours}`);
    ttlHours = DEFAULTS.codeTtlHours;
  }
  let codeHash: string | null = null;
  const rawHash = config.get('setup:codeHash');
  if (rawHash != null && rawHash !== '') {
    const lower = typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : rawHash;
    if (isSha256Hex(lower)) codeHash = lower;
    else problem('setup.codeHash', 'must be the SHA-256 (64 hex characters) of a setup code, or null');
  }
  const printCode = asBoolean(config.get('setup:printCode'), true);
  if (printCode == null) problem('setup.printCode', 'must be true or false');
  const rawReg = config.get('setup:registrationWhilePending') ?? 'closed';
  if (!(REGISTRATION_WHILE_PENDING as readonly unknown[]).includes(rawReg)) {
    problem('setup.registrationWhilePending', `must be one of: ${REGISTRATION_WHILE_PENDING.join(', ')}`);
  }

  // auth.adminAccessKeyScope
  const rawScope = config.get('auth:adminAccessKeyScope') ?? 'full';
  if (!(ADMIN_KEY_SCOPES as readonly unknown[]).includes(rawScope)) {
    problem('auth.adminAccessKeyScope', `must be one of: ${ADMIN_KEY_SCOPES.join(', ')}`);
  }

  // admin.session.*
  let ttlMinutes = asNumber(config.get('admin:session:ttlMinutes'), DEFAULTS.ttlMinutes);
  if (ttlMinutes == null || !Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > LIMITS.ttlMinutes) {
    problem('admin.session.ttlMinutes', `must be a whole number of minutes from 1 to ${LIMITS.ttlMinutes}`);
    ttlMinutes = DEFAULTS.ttlMinutes;
  }
  let stepUpMinutes = asNumber(config.get('admin:session:stepUpMinutes'), DEFAULTS.stepUpMinutes);
  if (stepUpMinutes == null || !Number.isInteger(stepUpMinutes) || stepUpMinutes < 1 || stepUpMinutes > LIMITS.stepUpMinutes) {
    problem('admin.session.stepUpMinutes', `must be a whole number of minutes from 1 to ${LIMITS.stepUpMinutes}`);
    stepUpMinutes = DEFAULTS.stepUpMinutes;
  }
  const requireMfa = asBoolean(config.get('admin:session:requireMfa'), true);
  if (requireMfa == null) problem('admin.session.requireMfa', 'must be true or false');

  // admin.localPolicy, admin.lockdown, portal.customCapabilities,
  // platform.configStore: their own validators.
  const warnings: string[] = [];
  for (const report of [describeLocalPolicy(config), describeLockdown(config), describeCustomCapabilities(config), describeConfigStore(config)]) {
    problems.push(...report.problems);
    warnings.push(...report.warnings);
  }

  const value: AdminConfig = {
    portal: { site, url, allowedOrigins, spaces, modules },
    setup: {
      codeTtlMs: ttlHours * 3600 * 1000,
      codeHash,
      printCode: printCode ?? true,
      registrationWhilePending: (REGISTRATION_WHILE_PENDING as readonly unknown[]).includes(rawReg) ? rawReg as RegistrationWhilePending : 'closed'
    },
    adminAccessKeyScope: (ADMIN_KEY_SCOPES as readonly unknown[]).includes(rawScope) ? rawScope as AdminKeyScope : 'full',
    session: {
      ttlMs: ttlMinutes * 60 * 1000,
      stepUpMs: stepUpMinutes * 60 * 1000,
      requireMfa: requireMfa ?? true
    }
  };
  return { value, problems, warnings };
}

/** The resolved values; throws one Error listing every problem (boot paths, after validation passed). */
export function readAdminConfig (config: ConfigReader): AdminConfig {
  const { value, problems } = describeAdminConfig(config);
  if (problems.length > 0) throw new Error('Invalid administration configuration: ' + problems.map((p) => p.message).join('; '));
  return value;
}

/** Whether administrators must have passed a second factor: MFA is on for the platform and required for them. */
export function adminMfaRequired (config: ConfigReader): boolean {
  if (readAdminConfig(config).session.requireMfa !== true) return false;
  const mfa = config.get('services:mfa') as { active?: unknown } | null | undefined;
  return mfa != null && (mfa.active === true || mfa.active === 'true');
}

function trimSlash (url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The portal's address: on this platform, derived from `portal.site` and the
 * topology (by the same rule the install wizard prints); outside it,
 * `portal.url`; else null.
 */
export function portalUrl (config: ConfigReader): string | null {
  const { site, url } = describeAdminConfig(config).value.portal;
  if (url != null) return url;
  if (site == null) return null;
  const publicUrl = config.get('dnsLess:publicUrl');
  if (config.get('dnsLess:isActive') === true && typeof publicUrl === 'string' && publicUrl !== '') {
    return portalAddress({ site, dnsLess: true, publicUrl });
  }
  const domain = config.get('dns:domain');
  if (typeof domain === 'string' && domain !== '') return portalAddress({ site, dnsLess: false, dnsDomain: domain });
  return null;
}

/**
 * `GET /system/portal/settings`: what the portal shows on this platform
 * (public, nothing secret). Values of an invalid configuration fall back to
 * their defaults (the core does not boot with one).
 */
export function portalSettings (config: ConfigReader): { contract: number; spaces: string[]; modules: { disabled: string[]; order: string[] } } {
  const { spaces, modules } = describeAdminConfig(config).value.portal;
  return { contract: PORTAL_CONTRACT, spaces: [...spaces], modules: { disabled: [...modules.disabled], order: [...modules.order] } };
}

/** The `portal` field of service info, or null when no portal address is known. */
export function portalServiceInfo (config: ConfigReader): { contract: number; url: string } | null {
  const url = portalUrl(config);
  return url == null ? null : { contract: PORTAL_CONTRACT, url };
}

/** The built-in setup page of this core, or null when the core has no public address configured. */
export function setupPageUrl (config: ConfigReader): string | null {
  const publicUrl = config.get('dnsLess:publicUrl');
  if (config.get('dnsLess:isActive') === true && typeof publicUrl === 'string' && publicUrl !== '') {
    return trimSlash(publicUrl) + '/system/setup/';
  }
  const coreUrl = config.get('core:url');
  if (typeof coreUrl === 'string' && coreUrl !== '') return trimSlash(coreUrl) + '/system/setup/';
  return null;
}
