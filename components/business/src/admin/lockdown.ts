/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createHash } from 'node:crypto';
import { APIError } from 'errors';
import { CAPABILITY_NAMES } from './capabilities.ts';

/**
 * This core's lockdown (`admin.lockdown`, per-core YAML, never in the
 * platform store, no route edits it): administration capabilities and
 * platform configuration keys managed elsewhere (a PaaS, GitOps, a front
 * proxy), so not editable through the API on this core.
 *
 *   admin:
 *     lockdown:
 *       capabilities:
 *         dns: readonly        # editable (default) | readonly | hidden
 *       platformConfig:
 *         readonly: [service.name]
 *
 * - `readonly`: the capability's writes answer 403 `admin-lockdown-capability`;
 *   its reads still work.
 * - `hidden`: the same, and the portal context leaves the capability out of
 *   `capabilities` (the portal does not show the module).
 * - `platformConfig.readonly`: writing or deleting one of these platform
 *   configuration keys answers 403 `admin-lockdown-key`.
 *
 * It binds every subject: administrator sessions, the setup session and the
 * admin key, on the `/system` routes and on the admin-key writes outside
 * them (`/reg/records` = dns, `/reg/admin/servers/.../rename/...` = cores,
 * `/reg/admin/invitations/post` = invitations, account deletion by the admin
 * key = users; see `lockdownRefusal`). It never locks reads, the session routes, setup, role listing /
 * grant / revocation, nor claim codes: the way to administer the platform is
 * restricted with `auth.adminAccessKeyScope` and roles, not here, so a copied
 * profile cannot lock an operator out of removing an administrator. Naming
 * one of those capabilities with another state than `editable` is a boot
 * problem. Without the block everything stays editable.
 *
 * Profiles ready to copy: `config/lockdown-profiles/*.yml`.
 */

type ConfigReader = { get: (key: string) => unknown };

export type LockdownState = 'editable' | 'readonly' | 'hidden';

export type LockdownReport = {
  problems: Array<{ message: string; path: string[] }>;
  warnings: string[];
};

/** What the portal context shows: the capabilities that are not editable, the read-only keys. */
export type LockdownView = {
  capabilities: Record<string, 'readonly' | 'hidden'>;
  platformConfig: { readonly: string[] };
};

/** `admin.lockdown` resolved: invalid or never-lockable entries are left out. */
export type Lockdown = {
  capabilities: ReadonlyMap<string, 'readonly' | 'hidden'>;
  readonlyKeys: ReadonlySet<string>;
  /** Null when nothing is locked. */
  view: LockdownView | null;
  /** SHA-256 (hex) of the resolved lockdown: equal on two cores that lock the same things. */
  digest: string;
  report: LockdownReport;
};

export const LOCKDOWN_STATES: readonly LockdownState[] = Object.freeze(['editable', 'readonly', 'hidden']);

/** Capabilities lockdown never locks: setup, role management, claim codes. */
export const NEVER_LOCKED_CAPABILITIES: ReadonlySet<string> = new Set(['setup', 'roles', 'claimCodes']);

/** A platform configuration key: dotted names of letters, digits, `_` and `-`. */
const KEY_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const KNOWN_CAPABILITIES = new Set(CAPABILITY_NAMES);

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolves and validates a raw `admin.lockdown` value. `schemaKeys`: the
 * platform configuration keys the store may hold (null: not known here, key
 * names are only checked for their form).
 */
export function parseLockdown (raw: unknown, schemaKeys: ReadonlySet<string> | null): Lockdown {
  const problems: LockdownReport['problems'] = [];
  const warnings: string[] = [];
  const problem = (path: string, message: string) =>
    problems.push({ message: `${path} ${message}`, path: path.split('.') });
  const capabilities = new Map<string, 'readonly' | 'hidden'>();
  const readonlyKeys = new Set<string>();

  if (raw != null) {
    if (!isPlainObject(raw)) {
      problem('admin.lockdown', 'must be a map with `capabilities` and / or `platformConfig`, or absent');
    } else {
      for (const k of Object.keys(raw)) {
        if (k !== 'capabilities' && k !== 'platformConfig') {
          problem('admin.lockdown.' + k, 'is not a lockdown setting (known: capabilities, platformConfig)');
        }
      }
      const caps = raw.capabilities;
      if (caps != null) {
        if (!isPlainObject(caps)) {
          problem('admin.lockdown.capabilities', `must be a map of capability names to ${LOCKDOWN_STATES.join(' | ')}`);
        } else {
          for (const [name, state] of Object.entries(caps)) {
            const path = 'admin.lockdown.capabilities.' + name;
            if (!KNOWN_CAPABILITIES.has(name)) {
              problem(path, `is not a capability of this release (known: ${CAPABILITY_NAMES.join(', ')})`);
            } else if (!(LOCKDOWN_STATES as readonly unknown[]).includes(state)) {
              problem(path, `must be one of: ${LOCKDOWN_STATES.join(', ')}`);
            } else if (state !== 'editable' && NEVER_LOCKED_CAPABILITIES.has(name)) {
              problem(path, 'cannot be locked: setup, role management and claim codes stay reachable through the API ' +
                '(restrict them with auth.adminAccessKeyScope and administrator roles); remove the entry');
            } else if (state !== 'editable') {
              capabilities.set(name, state as 'readonly' | 'hidden');
            }
          }
        }
      }
      const pc = raw.platformConfig;
      if (pc != null) {
        if (!isPlainObject(pc)) {
          problem('admin.lockdown.platformConfig', 'must be a map with `readonly` (a list of platform configuration keys)');
        } else {
          for (const k of Object.keys(pc)) {
            if (k !== 'readonly') problem('admin.lockdown.platformConfig.' + k, 'is not a lockdown setting (known: readonly)');
          }
          const keys = pc.readonly;
          if (keys != null) {
            if (!Array.isArray(keys)) {
              problem('admin.lockdown.platformConfig.readonly', 'must be a list of platform configuration keys (dotted names)');
            } else {
              for (const key of keys) {
                if (typeof key !== 'string' || !KEY_RE.test(key)) {
                  problem('admin.lockdown.platformConfig.readonly', `holds ${JSON.stringify(key)}, which is not a platform configuration key (a dotted name such as service.name)`);
                } else if (schemaKeys != null && !schemaKeys.has(key)) {
                  problem('admin.lockdown.platformConfig.readonly', `holds '${key}', which is not a key the platform store holds in this release` +
                    (schemaKeys.size > 0 ? ` (known: ${[...schemaKeys].sort().join(', ')})` : ''));
                } else {
                  readonlyKeys.add(key);
                }
              }
            }
          }
        }
      }
    }
  }

  const sortedCaps = [...capabilities].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sortedKeys = [...readonlyKeys].sort();
  const view: LockdownView | null = sortedCaps.length === 0 && sortedKeys.length === 0
    ? null
    : { capabilities: Object.fromEntries(sortedCaps), platformConfig: { readonly: sortedKeys } };
  const digest = createHash('sha256')
    .update(JSON.stringify({ capabilities: sortedCaps, readonly: sortedKeys }))
    .digest('hex');
  return { capabilities, readonlyKeys, view, digest, report: { problems, warnings } };
}

/**
 * The platform configuration keys the store may hold in this release (the
 * keys of the platform configuration schema). Null: not known in this
 * build, so `platformConfig.readonly` keys are checked for their form only.
 */
const PLATFORM_CONFIG_KEYS: ReadonlySet<string> | null = null;

// --- Reading, cached per configuration object --- //

/**
 * One entry per configuration object, reused while `admin.lockdown` reads
 * the same (the gate, the lockdown step and `describeAdminConfig` read it on
 * every call; tests change it on the same object).
 */
const cache = new WeakMap<object, { text: string; lockdown: Lockdown }>();

/** This core's lockdown, resolved (cheap: cached per configuration object). */
export function readLockdown (config: ConfigReader): Lockdown {
  const raw = config.get('admin:lockdown');
  const text = raw == null ? '' : JSON.stringify(raw);
  const hit = cache.get(config);
  if (hit != null && hit.text === text) return hit.lockdown;
  const lockdown = parseLockdown(raw, PLATFORM_CONFIG_KEYS);
  cache.set(config, { text, lockdown });
  return lockdown;
}

/** Validates `admin.lockdown`. Never throws; problems name their key path. */
export function describeLockdown (config: ConfigReader): LockdownReport {
  try {
    const { report } = readLockdown(config);
    return { problems: [...report.problems], warnings: [...report.warnings] };
  } catch (err) {
    return { problems: [{ message: `admin.lockdown could not be read: ${(err as Error).message}`, path: ['admin', 'lockdown'] }], warnings: [] };
  }
}

/** The lockdown as the portal context shows it, or null when nothing is locked. */
export function lockdownView (config: ConfigReader): LockdownView | null {
  const { view } = readLockdown(config);
  return view == null ? null : { capabilities: { ...view.capabilities }, platformConfig: { readonly: [...view.platformConfig.readonly] } };
}

/** `names` without the capabilities the lockdown hides. */
export function withoutHiddenCapabilities (config: ConfigReader, names: string[]): string[] {
  const { capabilities } = readLockdown(config);
  if (capabilities.size === 0) return names;
  return names.filter((n) => capabilities.get(n) !== 'hidden');
}

/** The state of one capability on this core. */
export function capabilityState (config: ConfigReader, name: string): LockdownState {
  if (NEVER_LOCKED_CAPABILITIES.has(name)) return 'editable';
  return readLockdown(config).capabilities.get(name) ?? 'editable';
}

/** Whether a platform configuration key is read-only on this core. */
export function isPlatformConfigKeyReadonly (config: ConfigReader, key: string): boolean {
  return readLockdown(config).readonlyKeys.has(key);
}

/**
 * The refusal of a write of `capability` on this core, or null when it may
 * go on. For every admin write, inside `/system` (the lockdown step) and
 * outside it (the admin-key routes under `/reg`, account deletion by the
 * admin key):
 * - a never-locked capability: null;
 * - an invalid `admin.lockdown` (a core does not boot with one; reachable
 *   only when the value changes under a running process): 500
 *   `admin-lockdown-invalid`, so a mistyped state never unlocks a write;
 * - `readonly` or `hidden`: 403 `admin-lockdown-capability`.
 */
export function lockdownRefusal (config: ConfigReader, capability: string): APIError | null {
  if (NEVER_LOCKED_CAPABILITIES.has(capability)) return null;
  const lockdown = readLockdown(config);
  if (lockdown.report.problems.length > 0) {
    return new APIError('admin-lockdown-invalid',
      'This core\'s admin.lockdown is invalid: administration writes are refused until it is fixed (see bin/check-config.js).',
      { httpStatus: 500 });
  }
  if ((lockdown.capabilities.get(capability) ?? 'editable') === 'editable') return null;
  return new APIError('admin-lockdown-capability',
    `The capability "${capability}" is managed outside the API on this core (admin.lockdown): it cannot be changed here.`,
    { httpStatus: 403, data: { capability } });
}

/** The refusal of a write or deletion of the platform configuration `key` on this core, or null. */
export function lockdownKeyRefusal (config: ConfigReader, key: string): APIError | null {
  if (!isPlatformConfigKeyReadonly(config, key)) return null;
  return new APIError('admin-lockdown-key',
    `The platform configuration key "${key}" is managed outside the API on this core (admin.lockdown): it cannot be changed here.`,
    { httpStatus: 403, data: { key } });
}
