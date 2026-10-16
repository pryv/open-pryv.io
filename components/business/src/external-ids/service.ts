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

import { factory as errors } from 'errors';
import { getPlatform } from 'platform';
import {
  getNamespace, listNamespaces, namespaceToken, tokensFor, claimRow, releaseRow, getRowCore
} from 'platform/src/externalIdIndex.ts';
import type { ExtIdPlatformHandle, ExtIdNamespaceRow, ExtIdTokens } from 'platform/src/externalIdIndex.ts';
import { ExternalIdConflict } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { ExternalIdsLocalDB } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';
import { parseBlindedValue } from './value.ts';
import { getExternalIdsLocal } from './localIndex.ts';

export interface ExternalIdInfo {
  namespace: string;
  claimedAt: number;
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
  async claim (userId: string, namespace: string, rawValue: unknown): Promise<ExternalIdInfo> {
    const blindedValue = parseBlindedValue(rawValue);
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), blindedValue);
    const held = await this.db.getByUserAndNamespace(userId, tokens.nsToken);
    if (held != null) {
      if (held.valueToken === tokens.valueToken) return { namespace, claimedAt: held.claimedAt };
      throw errors.externalIdAlreadyClaimed(namespace, 'namespace-taken');
    }
    if (!await claimRow(this.platform, tokens)) throw errors.externalIdAlreadyClaimed(namespace, 'value-taken');
    const claimedAt = this.now();
    try {
      await this.db.insert({ userId, ...tokens, blindedValue, claimedAt });
    } catch (err) {
      await this.#releaseIfUnowned(tokens);
      if (err instanceof ExternalIdConflict) throw errors.externalIdAlreadyClaimed(namespace, err.reason);
      throw err;
    }
    return { namespace, claimedAt };
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
   * Swap the account's id in that namespace for a new one: claim the new id,
   * update the local row, release the old id. Behaves as `claim` when the
   * account holds nothing in the namespace.
   */
  async replace (userId: string, namespace: string, rawValue: unknown): Promise<ExternalIdInfo> {
    const blindedValue = parseBlindedValue(rawValue);
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), blindedValue);
    const held = await this.db.getByUserAndNamespace(userId, tokens.nsToken);
    if (held == null) return await this.claim(userId, namespace, blindedValue);
    if (held.valueToken === tokens.valueToken) return { namespace, claimedAt: held.claimedAt };
    const oldValueToken = held.valueToken;
    if (!await claimRow(this.platform, tokens)) throw errors.externalIdAlreadyClaimed(namespace, 'value-taken');
    const claimedAt = this.now();
    try {
      await this.db.replaceForUser(userId, tokens.nsToken, { valueToken: tokens.valueToken, blindedValue, claimedAt });
    } catch (err) {
      await this.#releaseIfUnowned(tokens);
      if (err instanceof ExternalIdConflict) throw errors.externalIdAlreadyClaimed(namespace, err.reason);
      throw err;
    }
    await releaseRow(this.platform, { nsToken: tokens.nsToken, valueToken: oldValueToken });
    return { namespace, claimedAt };
  }

  /** The account's ids: namespaces and claim dates only, never a value. */
  async list (userId: string): Promise<ExternalIdInfo[]> {
    const rows = await this.db.getByUser(userId);
    if (rows.length === 0) return [];
    const byToken = new Map<string, string>();
    for (const ns of await listNamespaces(this.platform)) {
      const row = await getNamespace(this.platform, ns.namespace);
      if (row != null) byToken.set(namespaceToken(this.platform, row), ns.namespace);
    }
    const result: ExternalIdInfo[] = [];
    for (const r of rows) {
      const namespace = byToken.get(r.nsToken);
      // A deleted namespace: the row stays until the reconcile reports it.
      if (namespace != null) result.push({ namespace, claimedAt: r.claimedAt });
    }
    return result.sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  /** True when this account holds exactly that id. */
  async holds (userId: string, namespace: string, rawValue: unknown): Promise<boolean> {
    const tokens = tokensFor(this.platform, await this.#namespaceRow(namespace), parseBlindedValue(rawValue));
    const row = await this.db.getByTokens(tokens.nsToken, tokens.valueToken);
    return row != null && row.userId === userId;
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

  /** Account deletion: release every id of the account (platform first, then local). */
  async releaseAllForUser (userId: string): Promise<number> {
    const rows = await this.db.getByUser(userId);
    for (const r of rows) await releaseRow(this.platform, { nsToken: r.nsToken, valueToken: r.valueToken });
    if (rows.length > 0) await this.db.deleteByUser(userId);
    return rows.length;
  }

  /**
   * Compensation after a failed local write: delete the platform row we may
   * have created, unless an account of this core holds the id (then the row
   * is legitimately ours).
   */
  async #releaseIfUnowned (tokens: ExtIdTokens): Promise<void> {
    if (await this.db.getByTokens(tokens.nsToken, tokens.valueToken) == null) {
      await releaseRow(this.platform, tokens);
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
