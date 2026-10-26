/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * External ids of this core's accounts: claim, release, replace, list, and the
 * checks the flows need.
 *
 * Two stores: the replicated platform row (which core holds the id) and this
 * core's local table (which account). Every operation writes the platform row
 * first and leaves the two in a state the reconcile can finish from (see
 * `bin/reconcile-user-cores.js --ext-ids`):
 *   - a platform row pointing here with no local owner: deleted by the reconcile;
 *   - a local row with no platform row: re-claimed by the reconcile.
 * The local table's unique key is the authoritative one-account-per-id check:
 * two accounts of this core both "win" the platform row.
 */

import { getLogger } from '@pryv/boiler';
import { factory as errors } from 'errors';
import { getPlatform } from 'platform';
import {
  getNamespace, listNamespaceRows, namespaceToken, tokensFor, claimRow, releaseRow, getRowCore
} from 'platform/src/externalIdIndex.ts';
import type { ExtIdPlatformHandle, ExtIdNamespaceRow, ExtIdTokens } from 'platform/src/externalIdIndex.ts';
import { ExternalIdConflict } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { ExternalIdsLocalDB, ExternalIdConflictReason } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';
import { parseBlindedValue } from './value.ts';
import { getExternalIdsLocal } from './localIndex.ts';
import { refreshExternalIdTokens } from './refresh.ts';

const logger = getLogger('external-ids');

export interface ExternalIdInfo {
  namespace: string;
  claimedAt: number;
}

export interface ReconcileSummary {
  localRows: number;
  refreshed: number;
  corruptTokens: number;
  staleDeleted: number;
  orphanUsersReleased: number;
  missingHealed: number;
  lostToOtherCore: number;
  namespaceMissing: number;
  /** Set when the local table is empty and stale rows were NOT deleted (see `forceEmptyLocal`). */
  refusedEmptyLocal?: boolean;
}

/** A validated `externalId` flow field. `blindedValue` and `tokens` never leave the server side except in the auth request's poll body. */
export interface FlowExternalId {
  namespace: string;
  label: string;
  blindedValue: string;
  mode: 'hint' | 'forced';
  tokens: ExtIdTokens;
}

export interface RegistrationClaim {
  field: FlowExternalId;
  /** True when the platform row points at this core (claimed now, or already ours). */
  platformClaimed: boolean;
}

/** `created` is false when the account already held that exact value. */
export interface ClaimResult {
  externalId: ExternalIdInfo;
  created: boolean;
}

/**
 * One id of an account in a per-user backup. The blinded value is a claim
 * credential: as sensitive as the rest of the backup, never logged.
 */
export interface ExternalIdBackupEntry {
  namespace: string;
  blindedValue: string;
  claimedAt: number;
}

/** What a restore did with the backed-up ids of an account. */
export interface ExternalIdRestoreSummary {
  restored: number;
  /** Held by another account or another core: left with its holder. */
  lost: number;
  /** The namespace does not exist on this platform. */
  namespaceMissing: number;
  /** Not a well-formed entry. */
  invalid: number;
}

export interface ExtIdServicePlatform extends ExtIdPlatformHandle {
  coreIdToUrl (coreId: string): string;
}

export class ExternalIdsService {
  platform: ExtIdServicePlatform;
  db: ExternalIdsLocalDB;
  now: () => number;

  constructor (platform: ExtIdServicePlatform, db: ExternalIdsLocalDB, now: () => number = () => Date.now() / 1000) {
    this.platform = platform;
    this.db = db;
    this.now = now;
  }

  async #namespaceRow (namespace: unknown): Promise<ExtIdNamespaceRow> {
    const row = typeof namespace === 'string' ? await getNamespace(this.platform, namespace) : null;
    if (row == null) throw errors.invalidParametersFormat('Unknown external-id namespace.', { param: 'namespace' });
    return row;
  }

  /**
   * Link the id to the account. Idempotent for the account already holding
   * that value; 409 when another account holds it (on any core) or when the
   * account holds another id in the namespace.
   */
  async claim (userId: string, namespace: string, rawValue: unknown): Promise<ClaimResult> {
    const blindedValue = parseBlindedValue(rawValue);
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), blindedValue);
    const held = await this.db.getByUserAndNamespace(userId, tokens.nsToken);
    if (held != null) {
      if (held.valueToken === tokens.valueToken) return { externalId: { namespace, claimedAt: held.claimedAt }, created: false };
      throw errors.externalIdAlreadyClaimed(namespace, 'namespace-taken');
    }
    const claimedAt = this.now();
    const outcome = await this.#link(userId, tokens, blindedValue, claimedAt);
    if (outcome !== 'linked') throw errors.externalIdAlreadyClaimed(namespace, outcome);
    return { externalId: { namespace, claimedAt }, created: true };
  }

  /**
   * Claim the platform row for this core, then write the local row. When
   * either is held (another core, another account of this core, another id of
   * the account in the namespace), nothing is left behind and the reason is
   * returned.
   */
  async #link (userId: string, tokens: ExtIdTokens, blindedValue: string, claimedAt: number): Promise<'linked' | ExternalIdConflictReason> {
    if (!await claimRow(this.platform, tokens)) return 'value-taken';
    try {
      await this.db.insert({ userId, ...tokens, blindedValue, claimedAt });
    } catch (err) {
      await this.#releaseIfUnowned(tokens);
      if (err instanceof ExternalIdConflict) return err.reason;
      throw err;
    }
    return 'linked';
  }

  /** Unlink the account's id in that namespace (idempotent). */
  async release (userId: string, namespace: string): Promise<void> {
    const nsToken = namespaceToken(this.platform, await this.#namespaceRow(namespace));
    const held = await this.db.getByUserAndNamespace(userId, nsToken);
    if (held == null) return;
    await releaseRow(this.platform, { nsToken, valueToken: held.valueToken });
    await this.db.deleteByUserAndNamespace(userId, nsToken);
  }

  /**
   * An administrator's release of an id (the remedy for an id claimed by the
   * wrong account). On the core that holds it: released from the account
   * holding it (platform row, then local row), that account returned so it can
   * be told. Held on another core: that core's URL. Held by nobody here: none.
   * The platform row decides which core holds the id.
   */
  async adminRelease (namespace: string, rawValue: unknown): Promise<
    { kind: 'released'; userId: string; label: string } | { kind: 'remote'; coreUrl: string } | { kind: 'none' }
  > {
    const nsRow = await this.#namespaceRow(namespace);
    const tokens = tokensFor(this.platform, nsRow, parseBlindedValue(rawValue));
    const coreId = await getRowCore(this.platform, tokens);
    if (coreId != null && coreId !== this.platform.coreId) return { kind: 'remote', coreUrl: this.platform.coreIdToUrl(coreId) };
    const row = await this.db.getByTokens(tokens.nsToken, tokens.valueToken);
    if (row == null) return { kind: 'none' };
    // Exactly this id, by its tokens: a concurrent `replace` of the holder's
    // id must not have its new id released as collateral.
    await releaseRow(this.platform, tokens);
    await this.db.deleteByTokens(tokens.nsToken, tokens.valueToken);
    return { kind: 'released', userId: row.userId, label: nsRow.label };
  }

  /**
   * Swap the account's id in that namespace for a new one: claim the new id,
   * update the local row, release the old id. Behaves as `claim` when the
   * account holds nothing in the namespace.
   */
  async replace (userId: string, namespace: string, rawValue: unknown): Promise<ClaimResult> {
    const blindedValue = parseBlindedValue(rawValue);
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), blindedValue);
    const held = await this.db.getByUserAndNamespace(userId, tokens.nsToken);
    if (held == null) return await this.claim(userId, namespace, blindedValue);
    if (held.valueToken === tokens.valueToken) return { externalId: { namespace, claimedAt: held.claimedAt }, created: false };
    const oldValueToken = held.valueToken;
    if (!await claimRow(this.platform, tokens)) throw errors.externalIdAlreadyClaimed(namespace, 'value-taken');
    const claimedAt = this.now();
    try {
      // The row may have gone since it was read (a concurrent release or
      // deletion): then this is a plain claim of the new value.
      if (!await this.db.replaceForUser(userId, tokens.nsToken, { valueToken: tokens.valueToken, blindedValue, claimedAt })) {
        await this.db.insert({ userId, ...tokens, blindedValue, claimedAt });
      }
    } catch (err) {
      await this.#releaseIfUnowned(tokens);
      if (err instanceof ExternalIdConflict) throw errors.externalIdAlreadyClaimed(namespace, err.reason);
      throw err;
    }
    await releaseRow(this.platform, { nsToken: tokens.nsToken, valueToken: oldValueToken });
    return { externalId: { namespace, claimedAt }, created: true };
  }

  /** The account's ids: namespaces and claim dates only, never a value. */
  async list (userId: string): Promise<ExternalIdInfo[]> {
    return (await this.exportForUser(userId)).map(({ namespace, claimedAt }) => ({ namespace, claimedAt }));
  }

  /**
   * The account's ids with their blinded values, for its backup. A row of a
   * deleted namespace is left out (the reconcile reports it).
   */
  async exportForUser (userId: string): Promise<ExternalIdBackupEntry[]> {
    const rows = await this.db.getByUser(userId);
    if (rows.length === 0) return [];
    const byToken = new Map<string, string>();
    for (const { namespace, row } of await listNamespaceRows(this.platform)) {
      byToken.set(namespaceToken(this.platform, row), namespace);
    }
    const result: ExternalIdBackupEntry[] = [];
    for (const r of rows) {
      const namespace = byToken.get(r.nsToken);
      // A deleted namespace: the row stays until the reconcile reports it.
      if (namespace != null) result.push({ namespace, blindedValue: r.blindedValue, claimedAt: r.claimedAt });
    }
    return result.sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  /**
   * Restore: link the backed-up ids to the account again, with their claim
   * dates. The tokens are those of this platform (its pepper, the namespace's
   * salt here). An id held meanwhile by another core or another account is
   * left with its holder and counted lost, never overwritten; an id of a
   * namespace this platform does not have is skipped. Idempotent: an id the
   * account already holds counts as restored.
   */
  async restoreForUser (userId: string, entries: unknown[]): Promise<ExternalIdRestoreSummary> {
    const summary: ExternalIdRestoreSummary = { restored: 0, lost: 0, namespaceMissing: 0, invalid: 0 };
    if (entries.length === 0) return summary;
    const namespaces = new Map<string, ExtIdNamespaceRow>();
    for (const { namespace, row } of await listNamespaceRows(this.platform)) namespaces.set(namespace, row);
    for (const raw of entries) {
      const entry = (raw != null && typeof raw === 'object' ? raw : {}) as { namespace?: unknown, blindedValue?: unknown, claimedAt?: unknown };
      let blindedValue: string;
      try {
        blindedValue = parseBlindedValue(entry.blindedValue);
      } catch {
        summary.invalid++;
        continue;
      }
      if (typeof entry.namespace !== 'string') {
        summary.invalid++;
        continue;
      }
      const nsRow = namespaces.get(entry.namespace);
      if (nsRow == null) {
        summary.namespaceMissing++;
        continue;
      }
      const claimedAt = typeof entry.claimedAt === 'number' && Number.isFinite(entry.claimedAt) ? entry.claimedAt : this.now();
      const tokens = tokensFor(this.platform, nsRow, blindedValue);
      if (await this.#link(userId, tokens, blindedValue, claimedAt) === 'linked') {
        summary.restored++;
        continue;
      }
      const local = await this.db.getByTokens(tokens.nsToken, tokens.valueToken);
      if (local != null && local.userId === userId) {
        if ((await getRowCore(this.platform, tokens)) === this.platform.coreId) {
          summary.restored++;
          continue;
        }
        // The account's own row, lost to another core: dropped, as the reconcile does.
        await this.db.deleteByUserAndNamespace(userId, tokens.nsToken);
      }
      summary.lost++;
    }
    return summary;
  }

  /**
   * True when this account holds exactly that id: the platform row names this
   * core (it arbitrates between cores) AND the local row names the account (it
   * arbitrates between the accounts of this core). A local row left behind by
   * a lost reconcile never passes on its own.
   */
  async holds (userId: string, namespace: string, rawValue: unknown): Promise<boolean> {
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), parseBlindedValue(rawValue));
    const row = await this.db.getByTokens(tokens.nsToken, tokens.valueToken);
    if (row == null || row.userId !== userId) return false;
    return (await getRowCore(this.platform, tokens)) === this.platform.coreId;
  }

  /**
   * Forced-mode registration, before anything is reserved: true when the id is
   * held anywhere (a platform row on any core, this one included, or a local
   * row of this core). A stale row fails closed until the reconcile runs.
   */
  async isClaimed (field: FlowExternalId): Promise<boolean> {
    if ((await getRowCore(this.platform, field.tokens)) != null) return true;
    return (await this.db.getByTokens(field.tokens.nsToken, field.tokens.valueToken)) != null;
  }

  /**
   * The base URL of the core holding the id, or null (unknown namespace and
   * unclaimed id alike). The value is still validated (400 on a malformed one).
   */
  async lookupCoreUrl (namespace: unknown, rawValue: unknown): Promise<string | null> {
    const blindedValue = parseBlindedValue(rawValue);
    const row = typeof namespace === 'string' ? await getNamespace(this.platform, namespace) : null;
    if (row == null) return null;
    const coreId = await getRowCore(this.platform, tokensFor(this.platform, row, blindedValue));
    return coreId == null ? null : this.platform.coreIdToUrl(coreId);
  }

  /**
   * The `externalId` field of a flow (auth request, registration): known
   * namespace, well-formed value, mode (the namespace's default when absent).
   * Errors name the field, never the value. In forced mode the auth-request
   * accept is checked server-side (`reg/externalIdCheck.ts`) and a
   * registration of a held id is refused (`isClaimed`).
   */
  async parseFlowField (raw: unknown): Promise<FlowExternalId> {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw errors.invalidParametersFormat('externalId must be { namespace, blindedValue, mode? }.', { param: 'externalId' });
    }
    const field = raw as { namespace?: unknown, blindedValue?: unknown, mode?: unknown };
    const blindedValue = parseBlindedValue(field.blindedValue, 'externalId.blindedValue');
    const row = typeof field.namespace === 'string' ? await getNamespace(this.platform, field.namespace) : null;
    if (row == null) throw errors.invalidParametersFormat('Unknown external-id namespace.', { param: 'externalId.namespace' });
    const mode = field.mode ?? row.defaultMode;
    if (mode !== 'hint' && mode !== 'forced') {
      throw errors.invalidParametersFormat('externalId.mode must be "hint" or "forced".', { param: 'externalId.mode' });
    }
    return { namespace: field.namespace as string, label: row.label, blindedValue, mode, tokens: tokensFor(this.platform, row, blindedValue) };
  }

  /**
   * Registration, before the account is written: claim the id for this core
   * when nobody holds it. A held id leaves the registration unlinked (hint
   * mode: the user is sent to sign in instead).
   */
  async reserveAtRegistration (field: FlowExternalId): Promise<RegistrationClaim> {
    return { field, platformClaimed: await claimRow(this.platform, field.tokens) };
  }

  /** The account could not be written: give the platform row back. */
  async releaseRegistrationClaim (claim: RegistrationClaim): Promise<void> {
    if (claim.platformClaimed) await this.#releaseIfUnowned(claim.field.tokens);
  }

  /**
   * The account is written: link the id to it. False when it could not be
   * linked (held by another account of this core meanwhile); the account
   * stays, unlinked.
   */
  async linkAtRegistration (userId: string, claim: RegistrationClaim): Promise<boolean> {
    if (!claim.platformClaimed) return false;
    try {
      await this.db.insert({ userId, ...claim.field.tokens, blindedValue: claim.field.blindedValue, claimedAt: this.now() });
      return true;
    } catch (err) {
      await this.#releaseIfUnowned(claim.field.tokens);
      if (err instanceof ExternalIdConflict) return false;
      throw err;
    }
  }

  /** Account deletion: release every id of the account (platform first, then local). */
  async releaseAllForUser (userId: string): Promise<number> {
    const rows = await this.db.getByUser(userId);
    for (const r of rows) await releaseRow(this.platform, { nsToken: r.nsToken, valueToken: r.valueToken });
    if (rows.length > 0) await this.db.deleteByUser(userId);
    return rows.length;
  }

  /**
   * Bring this core's two stores back in line (operator tool, run per core):
   *   - stale self-row: a platform row pointing here with no local owner: deleted;
   *   - a local row of an account that no longer exists: released and deleted;
   *   - missing self-row: a local row with no platform row: re-claimed, or, when
   *     another core holds the id by now, the local row is deleted (lost);
   *   - a local row of a namespace that no longer exists: reported, never deleted
   *     (a lost namespace row is noticed, not silently erased).
   * Rows pointing at other cores are never touched. Idempotent.
   */
  async reconcile (options: {
    dryRun: boolean,
    userExists: (userId: string) => Promise<boolean>,
    oldHasher?: { hashFor (field: string, value: string): string } | null,
    forceEmptyLocal?: boolean
  }): Promise<ReconcileSummary> {
    const { dryRun, userExists } = options;
    // First bring every local row to the current tokens (a mode switch or a
    // pepper rotation since the last run), so the passes below compare like
    // with like.
    const refresh = await refreshExternalIdTokens({ platform: this.platform, db: this.db, oldHasher: options.oldHasher, dryRun });
    const summary: ReconcileSummary = {
      localRows: 0,
      refreshed: refresh.refreshed,
      corruptTokens: refresh.corrupt,
      staleDeleted: 0,
      orphanUsersReleased: 0,
      missingHealed: 0,
      // A refresh that lost the new key to another core leaves the local row;
      // the pass below counts it and drops it.
      lostToOtherCore: 0,
      namespaceMissing: refresh.namespaceMissing
    };
    const localRows = await this.db.scanAll();
    summary.localRows = localRows.length;
    const localKeys = new Set(localRows.map((r) => r.nsToken + '/' + r.valueToken));
    const platformRows = new Map<string, string>();
    for (const r of await this.platform.getAllCoreRows('ext-id/')) platformRows.set(r.key, r.coreId);

    const staleKeys: string[] = [];
    for (const [key, coreId] of platformRows) {
      if (coreId !== this.platform.coreId || localKeys.has(key)) continue;
      staleKeys.push(key);
    }
    summary.staleDeleted = staleKeys.length;
    // An empty local table facing rows of this core is more likely a lost
    // table (a partial restore, a wrong --config) than ids nobody holds:
    // deleting the rows would free every id of the core. Refused unless forced.
    if (localRows.length === 0 && staleKeys.length > 0 && !dryRun && options.forceEmptyLocal !== true) {
      summary.refusedEmptyLocal = true;
      summary.staleDeleted = 0;
      return summary;
    }
    if (!dryRun) {
      for (const key of staleKeys) await this.platform.deleteCoreRowIfValue('ext-id/', key, this.platform.coreId);
    }

    const goneUsers = new Set<string>();
    for (const r of localRows) {
      const tokens = { nsToken: r.nsToken, valueToken: r.valueToken };
      if (goneUsers.has(r.userId) || !await userExists(r.userId)) {
        goneUsers.add(r.userId);
        summary.orphanUsersReleased++;
        if (!dryRun) {
          await releaseRow(this.platform, tokens);
          await this.db.deleteByUserAndNamespace(r.userId, r.nsToken);
        }
        continue;
      }
      const holder = platformRows.get(r.nsToken + '/' + r.valueToken);
      if (holder === this.platform.coreId) continue;
      if (holder == null && (dryRun || await claimRow(this.platform, tokens))) {
        summary.missingHealed++;
        continue;
      }
      summary.lostToOtherCore++;
      if (!dryRun) await this.db.deleteByUserAndNamespace(r.userId, r.nsToken);
    }
    return summary;
  }

  /**
   * Compensation after a failed local write: delete the platform row we may
   * have created, unless an account of this core holds the id (then the row
   * is legitimately ours).
   */
  async #releaseIfUnowned (tokens: ExtIdTokens): Promise<void> {
    if (await this.db.getByTokens(tokens.nsToken, tokens.valueToken) != null) return;
    await releaseRow(this.platform, tokens);
    // Another request of this core may have committed its local row for the
    // same id between the read above and the delete: claim the row back.
    if (await this.db.getByTokens(tokens.nsToken, tokens.valueToken) != null && !await claimRow(this.platform, tokens)) {
      logger.warn('external id: a local row lost its platform row to another core during a compensation; the reconcile reports it');
    }
  }
}

let instance: Promise<ExternalIdsService> | null = null;

export function getExternalIdsService (): Promise<ExternalIdsService> {
  if (instance == null) {
    instance = (async () => new ExternalIdsService(await getPlatform() as ExtIdServicePlatform, await getExternalIdsLocal()))();
    instance.catch(() => { instance = null; });
  }
  return instance;
}
