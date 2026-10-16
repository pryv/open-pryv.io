/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * External-id index: typed rows over PlatformDB (same caller-owns-prefix shape
 * as accessIndex).
 *
 * Purpose: map an external record id (an EHR patient id, for example) to the
 * core of the ONE account that holds it, platform-wide, without the platform
 * ever seeing the id. The caller blinds the id with its own namespace key
 * (`blindedValue = HMAC(K_namespace, id)`); the platform only ever handles
 * that blinded value, and derives its row key from it.
 *
 * Key namespaces owned here:
 *   - `ext-id-ns/<namespace>` -> JSON { createdAt, salt, label, defaultMode }:
 *     one row per namespace, admin-managed. `salt` is server-generated and
 *     never returned to a client.
 *   - `ext-id/<nsToken>/<valueToken>` -> coreId: which core holds the id.
 *     The account is NOT here: only the home core knows it, in its local
 *     table. Two accounts of one core both "win" this row (claim-or-confirm
 *     is per core), so the home core's local unique index is the
 *     authoritative uniqueness step.
 *
 * Tokens go through `hashFor` like every other PlatformDB family: an HMAC
 * under the cluster pepper in hashed mode, the value as is in cleartext mode
 * (then `nsToken` is the salt and `valueToken` the blinded value; both are
 * base64url, so neither breaks the `/`-separated key).
 */

import { randomBytes } from 'node:crypto';
import { factory as errors } from 'errors';

export const NS_PREFIX = 'ext-id-ns/';
export const ROW_PREFIX = 'ext-id/';

/** hashFor field of the namespace token; the value token's field embeds nsToken. */
const NS_FIELD = 'ext-id-ns';
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const LABEL_MAX = 80;
const SALT_BYTES = 32;

export type ExtIdMode = 'hint' | 'forced';
const MODES: ReadonlySet<string> = new Set(['hint', 'forced']);

/**
 * The subset of the Platform wrapper this module depends on (structural, so
 * tests can pass a fake).
 */
export interface ExtIdPlatformHandle {
  hashFor (field: string, value: string): string;
  readonly coreId: string;
  getPlatformKv (key: string): Promise<string | null>;
  setPlatformKv (key: string, value: string): Promise<void>;
  deletePlatformKv (key: string): Promise<void>;
  listPlatformKvEntries (prefix: string): Promise<Array<{ key: string, value: string }>>;
  claimCoreRow (prefix: string, key: string, coreId: string): Promise<boolean>;
  getCoreRow (prefix: string, key: string): Promise<string | null>;
  deleteCoreRowIfValue (prefix: string, key: string, coreId: string): Promise<boolean>;
  getAllCoreRows (prefix: string): Promise<Array<{ key: string, coreId: string }>>;
}

/** Stored namespace row. */
export interface ExtIdNamespaceRow {
  createdAt: number;
  salt: string;
  label: string;
  defaultMode: ExtIdMode;
}

/** A namespace as clients see it: never the salt. */
export interface ExtIdNamespaceInfo {
  namespace: string;
  createdAt: number;
  label: string;
  defaultMode: ExtIdMode;
}

export interface ExtIdTokens {
  nsToken: string;
  valueToken: string;
}

export function isValidNamespaceName (name: unknown): name is string {
  return typeof name === 'string' && NAMESPACE_RE.test(name);
}

function assertNamespaceName (name: unknown): asserts name is string {
  if (!isValidNamespaceName(name)) {
    throw errors.invalidParametersFormat('The namespace must be 2 to 63 characters: lower-case letters, digits and "-", starting with a letter or digit.', { param: 'namespace' });
  }
}

function parseRow (raw: string | null): ExtIdNamespaceRow | null {
  if (raw == null) return null;
  return JSON.parse(raw) as ExtIdNamespaceRow;
}

export function namespaceInfo (namespace: string, row: ExtIdNamespaceRow): ExtIdNamespaceInfo {
  return { namespace, createdAt: row.createdAt, label: row.label, defaultMode: row.defaultMode };
}

export async function getNamespace (platform: ExtIdPlatformHandle, namespace: string): Promise<ExtIdNamespaceRow | null> {
  if (!isValidNamespaceName(namespace)) return null;
  return parseRow(await platform.getPlatformKv(NS_PREFIX + namespace));
}

export async function listNamespaces (platform: ExtIdPlatformHandle): Promise<ExtIdNamespaceInfo[]> {
  const entries = await platform.listPlatformKvEntries(NS_PREFIX);
  return entries
    .map((e) => namespaceInfo(e.key.slice(NS_PREFIX.length), JSON.parse(e.value) as ExtIdNamespaceRow))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/**
 * Create a namespace (fresh salt) or update its label / default mode. The
 * salt never changes once written: a new salt would orphan every claimed id.
 * Creation is atomic, so two concurrent creates end with one salt.
 */
export async function setNamespace (platform: ExtIdPlatformHandle, namespace: string,
  params: { label?: string, defaultMode?: string }, now: number): Promise<{ created: boolean, info: ExtIdNamespaceInfo }> {
  assertNamespaceName(namespace);
  const { label, defaultMode } = params;
  if (label != null && (typeof label !== 'string' || label.trim().length === 0 || label.length > LABEL_MAX)) {
    throw errors.invalidParametersFormat(`The label must be 1 to ${LABEL_MAX} characters.`, { param: 'label' });
  }
  if (defaultMode != null && !MODES.has(defaultMode)) {
    throw errors.invalidParametersFormat('The default mode must be "hint" or "forced".', { param: 'defaultMode' });
  }
  let existing = await getNamespace(platform, namespace);
  if (existing == null) {
    const row: ExtIdNamespaceRow = {
      createdAt: now,
      salt: randomBytes(SALT_BYTES).toString('base64url'),
      label: label ?? namespace,
      defaultMode: (defaultMode ?? 'hint') as ExtIdMode
    };
    // claim-or-confirm on the serialised row: true only when OUR row won.
    if (await platform.claimCoreRow(NS_PREFIX, namespace, JSON.stringify(row))) {
      return { created: true, info: namespaceInfo(namespace, row) };
    }
    existing = await getNamespace(platform, namespace);
    if (existing == null) throw new Error('external-id namespace vanished during creation: ' + namespace);
  }
  const updated: ExtIdNamespaceRow = {
    ...existing,
    label: label ?? existing.label,
    defaultMode: (defaultMode ?? existing.defaultMode) as ExtIdMode
  };
  await platform.setPlatformKv(NS_PREFIX + namespace, JSON.stringify(updated));
  return { created: false, info: namespaceInfo(namespace, updated) };
}

/**
 * Delete a namespace row. Refused while ids of the namespace are claimed,
 * unless `force`: the namespace row alone goes, and each core's reconcile then
 * reports its local ids of that namespace.
 */
export async function deleteNamespace (platform: ExtIdPlatformHandle, namespace: string,
  options: { force?: boolean } = {}): Promise<boolean> {
  const row = await getNamespace(platform, namespace);
  if (row == null) return false;
  if (options.force !== true) {
    // A JS prefix test, not a SQL LIKE: in cleartext mode the token is the
    // base64url salt, which may hold `_` (a LIKE wildcard).
    const nsPrefix = namespaceToken(platform, row) + '/';
    const rows = await platform.getAllCoreRows(ROW_PREFIX);
    if (rows.some((r) => r.key.startsWith(nsPrefix))) throw errors.externalIdNamespaceInUse(namespace);
  }
  await platform.deletePlatformKv(NS_PREFIX + namespace);
  return true;
}

export function namespaceToken (platform: ExtIdPlatformHandle, row: ExtIdNamespaceRow): string {
  return platform.hashFor(NS_FIELD, row.salt);
}

/** `blindedValue` must already be validated and canonical (base64url). */
export function tokensFor (platform: ExtIdPlatformHandle, row: ExtIdNamespaceRow, blindedValue: string): ExtIdTokens {
  const nsToken = namespaceToken(platform, row);
  return { nsToken, valueToken: platform.hashFor('ext-id:' + nsToken, blindedValue) };
}

function rowKey (tokens: ExtIdTokens): string {
  return tokens.nsToken + '/' + tokens.valueToken;
}

/** Claim the id for THIS core. False when another core holds it. */
export async function claimRow (platform: ExtIdPlatformHandle, tokens: ExtIdTokens): Promise<boolean> {
  return await platform.claimCoreRow(ROW_PREFIX, rowKey(tokens), platform.coreId);
}

/** Release the id only when THIS core holds it; true when a row was deleted. */
export async function releaseRow (platform: ExtIdPlatformHandle, tokens: ExtIdTokens): Promise<boolean> {
  return await platform.deleteCoreRowIfValue(ROW_PREFIX, rowKey(tokens), platform.coreId);
}

/** The core holding the id, or null. */
export async function getRowCore (platform: ExtIdPlatformHandle, tokens: ExtIdTokens): Promise<string | null> {
  return await platform.getCoreRow(ROW_PREFIX, rowKey(tokens));
}
