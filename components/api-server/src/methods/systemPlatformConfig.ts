/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ResultBag } from './_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import { auditAs, wrap } from './helpers/adminAudit.ts';
import {
  schema, keyDef, configPath, isValidKeyName, valueErrors, listEntries, getEntry, setEntry, unsetEntry, currentRev, coresBehind,
  UnknownKeyError, InvalidValueError, SOURCE_LABEL
} from 'business/src/platformConfig/index.ts';
import type { ScopedConfig, Entry, KeyDef, KvStore, UpdatedBy } from 'business/src/platformConfig/index.ts';
import { reloadAfterWrite, coreIdOf } from 'business/src/platformConfig/boot.ts';
import { readAdminConfig } from 'business/src/admin/config.ts';
import { isStepUpFresh } from 'business/src/admin/sessions.ts';
import { lockdownView } from 'business/src/admin/lockdown.ts';
import { fingerprint, fingerprintKey, stableStringify } from 'business/src/effectiveConfig/redact.ts';
import { factory as errors } from 'errors';
import { ready } from '@pryv/boiler';
import * as storages from 'storages';
import { platform } from 'platform';

/**
 * Methods of the platform-wide configuration held in the platform store
 * (routes in routes/system-admin-config.ts, method ids declared in
 * audit/src/apiMethods/platformConfig.ts). The /system gate checked
 * `config:read` / `config:write`; a write of a key marked sensitive also
 * needs a recent second factor from an administrator session.
 *
 * Audit: each write is recorded without a user, with the key and the values
 * before and after (fingerprints for a sensitive key). Reads are not audited.
 */

type Context = {
  adminSubject?: AdminSubject;
  access?: { id?: string } | null;
  auditIntegrityPayload?: unknown;
};

const STEP_UP_MESSAGE = 'This act needs a recent second factor: renew it with POST /system/admin/session/step-up, then repeat the request.';

export default async function (systemAPI: { register: (...args: unknown[]) => void }): Promise<void> {
  const config: ScopedConfig = await ready();
  const db = (): KvStore => storages.platformDB as KvStore;

  /** The keys this core's lockdown marks read-only (directly or through their capability). */
  function lockedOf (key: string, def: KeyDef): boolean {
    const view = lockdownView(config);
    if (view == null) return false;
    return view.platformConfig.readonly.includes(key) || view.capabilities[def.capability] != null;
  }

  function entryView (key: string, def: KeyDef, entry: Entry | null): Record<string, unknown> {
    const path = configPath(key);
    const loadable = entry != null && entryLoadable(key, entry);
    const out: Record<string, unknown> = {
      key,
      effective: config.get(path),
      source: loadable ? SOURCE_LABEL : 'local',
      appliesAt: def.appliesAt,
      sensitive: def.sensitive,
      capability: def.capability,
      locked: lockedOf(key, def)
    };
    if (entry != null && loadable) {
      out.value = entry.value;
      out.updatedAt = entry.updatedAt;
      out.updatedBy = entry.updatedBy;
      const local = config.getLocal(path);
      if (local !== undefined && !isDeepStrictEqual(local, entry.value)) out.localOverride = { value: local };
    }
    return out;
  }

  /** Whether the scope load takes the row (same check as business/src/platformConfig). */
  function entryLoadable (key: string, entry: Entry): boolean {
    return keyDef(key) != null && valueErrors(key, entry.value) == null;
  }

  function updatedByOf (subject: AdminSubject | undefined): UpdatedBy {
    const coreId = coreIdOf(config);
    if (subject?.kind === 'session') return { kind: 'session', userId: subject.userId, coreId };
    return { kind: subject?.kind === 'setup' ? 'setup' : 'admin-key', coreId };
  }

  function stepUpMissing (def: KeyDef, subject: AdminSubject | undefined): boolean {
    if (!def.sensitive || subject?.kind !== 'session' || subject.session == null) return false;
    return !isStepUpFresh(subject.session, Date.now(), readAdminConfig(config).session.stepUpMs);
  }

  /** What an audit record shows of a value: itself, or a fingerprint for a sensitive key. */
  function auditValue (key: string, def: KeyDef, entry: Entry | null): unknown {
    if (entry == null) return null;
    if (!def.sensitive) return entry.value;
    const fpKey = fingerprintKey(config.get('auth:filesReadTokenSecret'));
    return {
      fingerprint: fpKey != null
        ? fingerprint(fpKey, key, entry.value)
        : createHash('sha256').update(key + '\n' + stableStringify(entry.value)).digest('hex').slice(0, 16)
    };
  }

  function recordAct (context: Context, key: string, def: KeyDef, before: Entry | null, after: Entry | null): void {
    const base = (context.auditIntegrityPayload != null && typeof context.auditIntegrityPayload === 'object')
      ? context.auditIntegrityPayload as Record<string, unknown>
      : {};
    context.auditIntegrityPayload = { ...base, key, before: auditValue(key, def, before), after: auditValue(key, def, after) };
  }

  async function coreIds (): Promise<string[]> {
    const infos = await platform.getAllCoreInfos() as Array<{ id?: string } | null>;
    const ids = new Set<string>([coreIdOf(config)]);
    for (const info of infos) if (typeof info?.id === 'string') ids.add(info.id);
    return [...ids].sort();
  }

  function keyParam (params: Record<string, unknown>): string | null {
    return isValidKeyName(params.key) ? params.key : null;
  }

  function unknownKey (key: unknown) {
    return errors.unknownResource('platform configuration key', typeof key === 'string' ? key : undefined);
  }

  function extraParams (params: Record<string, unknown>, allowed: string[]) {
    const extra = Object.keys(params).filter((k) => !allowed.includes(k));
    return extra.length > 0 ? errors.invalidParametersFormat('Unknown parameter(s): ' + extra.join(', ') + '.', { parameters: extra }) : null;
  }

  systemAPI.register('system.platformConfig.list',
    auditAs('subject'),
    wrap(async (_context: Context, params, result: ResultBag) => {
      const extra = extraParams(params, []);
      if (extra != null) return extra;
      const rows = new Map((await listEntries(db())).map((e) => [e.key, e]));
      const entries = [];
      for (const key of Object.keys(schema()).sort()) entries.push(entryView(key, schema()[key], rows.get(key) ?? null));
      result.rev = await currentRev(db());
      result.entries = entries;
      result.coresBehind = await coresBehind(db(), await coreIds());
    }));

  systemAPI.register('system.platformConfig.get',
    auditAs('subject'),
    wrap(async (_context: Context, params, result: ResultBag) => {
      const key = keyParam(params);
      const def = key == null ? null : keyDef(key);
      if (key == null || def == null) return unknownKey(params.key);
      result.entry = entryView(key, def, await getEntry(db(), key));
    }));

  systemAPI.register('system.platformConfig.set',
    auditAs('subject'),
    wrap(async (context: Context, params, result: ResultBag) => {
      const extra = extraParams(params, ['key', 'value']);
      if (extra != null) return extra;
      const key = keyParam(params);
      const def = key == null ? null : keyDef(key);
      if (key == null || def == null) return unknownKey(params.key);
      if (!Object.prototype.hasOwnProperty.call(params, 'value')) {
        return errors.invalidParametersFormat('The body must be `{ "value": ... }`.', { key });
      }
      if (stepUpMissing(def, context.adminSubject)) return errors.forbidden(STEP_UP_MESSAGE, { stepUp: true });
      let written;
      try {
        written = await setEntry(db(), key, params.value, updatedByOf(context.adminSubject));
      } catch (err) {
        if (err instanceof InvalidValueError) return errors.invalidParametersFormat(`The value of "${key}" does not match its schema.`, { key, errors: err.errors });
        if (err instanceof UnknownKeyError) return unknownKey(key);
        throw err;
      }
      recordAct(context, key, def, written.before, written.after);
      await reloadAfterWrite(config, db());
      result.entry = entryView(key, def, written.after);
      result.appliesAt = def.appliesAt;
      result.rev = written.rev;
    }));

  systemAPI.register('system.platformConfig.delete',
    auditAs('subject'),
    wrap(async (context: Context, params, result: ResultBag) => {
      const key = keyParam(params);
      if (key == null) return unknownKey(params.key);
      const def = keyDef(key);
      if (def != null && stepUpMissing(def, context.adminSubject)) return errors.forbidden(STEP_UP_MESSAGE, { stepUp: true });
      let removed;
      try {
        removed = await unsetEntry(db(), key, updatedByOf(context.adminSubject));
      } catch (err) {
        if (err instanceof UnknownKeyError) return unknownKey(key);
        throw err;
      }
      if (removed.before != null) {
        recordAct(context, key, def ?? { schema: {}, appliesAt: 'restart', sensitive: true, capability: 'config' }, removed.before, null);
        await reloadAfterWrite(config, db());
      }
      result.key = key;
      result.deleted = removed.before != null;
      if (def != null) result.entry = entryView(key, def, null);
      result.rev = removed.rev;
    }));
}
