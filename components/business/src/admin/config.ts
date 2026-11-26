/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { hostedSiteNames } from '../hostedSites.ts';
import { isSha256Hex } from './codes.ts';
import { portalUrl as portalAddress } from './portalDefaults.ts';

/**
 * Configuration of setup and administration:
 *
 *   portal.site                     PLATFORM-WIDE  hosted site serving the portal (null: none; the
 *                                                  install wizard names it PORTAL_DEFAULT_SITE, `admin`)
 *   portal.cors.allowedOrigins      PLATFORM-WIDE  extra origins of a portal hosted outside the platform
 *   setup.codeTtlHours              PLATFORM-WIDE  lifetime of a setup code (24)
 *   setup.codeHash                  BOOTSTRAP      SHA-256 of an operator-supplied setup code (null)
 *   setup.printCode                 PER-CORE       print the setup code block at boot (true)
 *   setup.registrationWhilePending  PLATFORM-WIDE  closed | open (closed)
 *   auth.adminAccessKeyScope        PLATFORM-WIDE  full | break-glass (full)
 *   admin.session.ttlMinutes        PLATFORM-WIDE  admin session lifetime (60)
 *   admin.session.stepUpMinutes     PLATFORM-WIDE  age of the second factor accepted for a sensitive act (5)
 *   admin.session.requireMfa        PLATFORM-WIDE  administrators need MFA whenever the platform has it on (true)
 *
 * One validator for the boot-time config validation, `bin/check-config.js`
 * and the readers. Pure: reads the values it is given.
 */

type ConfigReader = { get: (key: string) => unknown };

export type AdminKeyScope = 'full' | 'break-glass';
export type RegistrationWhilePending = 'closed' | 'open';

export type AdminConfig = {
  portal: { site: string | null; allowedOrigins: string[] };
  setup: { codeTtlMs: number; codeHash: string | null; printCode: boolean; registrationWhilePending: RegistrationWhilePending };
  adminAccessKeyScope: AdminKeyScope;
  session: { ttlMs: number; stepUpMs: number; requireMfa: boolean };
};

export type AdminConfigReport = { value: AdminConfig; problems: Array<{ message: string; path: string[] }> };

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

  const value: AdminConfig = {
    portal: { site, allowedOrigins },
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
  return { value, problems };
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
 * The portal's address on this platform (derived from `portal.site` and the
 * topology, by the same rule the install wizard prints), or null.
 */
export function portalUrl (config: ConfigReader): string | null {
  const { site } = describeAdminConfig(config).value.portal;
  if (site == null) return null;
  const publicUrl = config.get('dnsLess:publicUrl');
  if (config.get('dnsLess:isActive') === true && typeof publicUrl === 'string' && publicUrl !== '') {
    return portalAddress({ site, dnsLess: true, publicUrl });
  }
  const domain = config.get('dns:domain');
  if (typeof domain === 'string' && domain !== '') return portalAddress({ site, dnsLess: false, dnsDomain: domain });
  return null;
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
