/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the `oauth.clientMetadataDocuments` settings (client metadata
 * documents: an https URL as `client_id`).
 *
 * - `mode`: `off` (the default: a URL `client_id` is an unknown client),
 *   `allowList` (only documents on `allowedHosts` become clients) or `any`
 *   (any https host that passes the URL rules); `deniedHosts` is refused in
 *   both modes. A host entry is a lower-case host name (exact match), with
 *   `:port` for another port than 443, or `*.example.com` (exactly one more
 *   label, never the apex).
 * - The cache and fetch bounds (`cacheSeconds`, `staleGraceSeconds`,
 *   `negativeCacheSeconds`, `fetchTimeoutMs`, `maxDocumentBytes`,
 *   `fetchesPerMinute`).
 * - `authMethods`: the client authentication methods a document may declare.
 * - `client`: the template, what such a client may be granted (a registry
 *   client row without an identity). The document never adds to it.
 *
 * Pure module: the configuration validator, `bin/check-config.js` and the
 * runtime read the same rules.
 */

import { isLifetime } from './clientLifetimes.ts';

export type ClientMetadataMode = 'off' | 'allowList' | 'any';

/** What a metadata-document client may be granted (copied onto every such row). */
export type MetadataClientTemplate = {
  /** The maximum scope set, in the installed extension's grammar. */
  scope: string[];
  allowedAudiences: string[];
  launchTypes: string[];
  subjectType: 'public' | 'pairwise';
  maxEntries: number;
  offlineAccessAllowed: boolean;
  accessTokenTTL: number | null;
  refreshTokenTTL: number | null;
  refreshTokenAbsoluteTTL: number | null;
  regions: string[];
};

export type ClientMetadataSettings = {
  mode: ClientMetadataMode;
  allowedHosts: string[];
  deniedHosts: string[];
  cacheSeconds: number;
  staleGraceSeconds: number;
  negativeCacheSeconds: number;
  fetchTimeoutMs: number;
  maxDocumentBytes: number;
  fetchesPerMinute: number;
  /** Fetches per minute and host (fixed). */
  fetchesPerMinutePerHost: number;
  authMethods: string[];
  client: MetadataClientTemplate;
};

/** The client authentication methods a metadata document may declare. */
export const METADATA_AUTH_METHODS: readonly string[] = Object.freeze(['none', 'private_key_jwt']);

/** Same bound as the synthesised offer ceiling (scopeGrammar's MAX_SYNTH_ENTRIES). */
export const MAX_TEMPLATE_ENTRIES = 1000;

const MODES: readonly string[] = ['off', 'allowList', 'any'];
const TOP_KEYS = ['mode', 'allowedHosts', 'deniedHosts', 'cacheSeconds', 'staleGraceSeconds', 'negativeCacheSeconds',
  'fetchTimeoutMs', 'maxDocumentBytes', 'fetchesPerMinute', 'authMethods', 'client'];
const TEMPLATE_KEYS = ['scope', 'allowedAudiences', 'launchTypes', 'subjectType', 'maxEntries', 'offlineAccessAllowed',
  'accessTokenTTL', 'refreshTokenTTL', 'refreshTokenAbsoluteTTL', 'regions'];
const REGION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_REGIONS = 32;
const MAX_HOST_ENTRIES = 256;

/** Bounds of the numeric settings: [minimum, maximum]. */
const NUMBER_BOUNDS: Record<string, [number, number]> = {
  cacheSeconds: [1, 30 * 24 * 3600],
  staleGraceSeconds: [0, 30 * 24 * 3600],
  negativeCacheSeconds: [0, 24 * 3600],
  fetchTimeoutMs: [1, 60000],
  maxDocumentBytes: [256, 1024 * 1024],
  fetchesPerMinute: [1, 100000],
};

export const DEFAULT_CLIENT_METADATA_SETTINGS: Readonly<ClientMetadataSettings> = Object.freeze({
  mode: 'off',
  allowedHosts: [],
  deniedHosts: [],
  cacheSeconds: 3600,
  staleGraceSeconds: 86400,
  negativeCacheSeconds: 60,
  fetchTimeoutMs: 5000,
  maxDocumentBytes: 16384,
  fetchesPerMinute: 60,
  fetchesPerMinutePerHost: 10,
  authMethods: ['none', 'private_key_jwt'],
  client: {
    scope: [],
    allowedAudiences: [],
    launchTypes: [],
    subjectType: 'pairwise' as const,
    maxEntries: 200,
    offlineAccessAllowed: true,
    accessTokenTTL: null,
    refreshTokenTTL: null,
    refreshTokenAbsoluteTTL: null,
    regions: [],
  },
});

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** The mode a raw value reads as (`false`, as YAML 1.1 reads `off`, is `off`), or null. */
function parseMode (v: unknown): ClientMetadataMode | null {
  if (v == null || v === false) return 'off';
  return typeof v === 'string' && MODES.includes(v) ? v as ClientMetadataMode : null;
}

/** A template `scope`: a space-separated string or a list of tokens, as a token list. */
function scopeTokens (v: unknown): string[] | null {
  if (v == null) return [];
  if (typeof v === 'string') return v.split(/\s+/).filter((t) => t !== '');
  if (Array.isArray(v) && v.every((t) => typeof t === 'string')) return v.flatMap((t: string) => t.split(/\s+/)).filter((t) => t !== '');
  return null;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a host entry of `allowedHosts` / `deniedHosts` never matches, or null. */
export function hostEntryProblem (entry: unknown): string | null {
  if (typeof entry !== 'string' || entry.length === 0) return 'must be a non-empty string';
  if (entry !== entry.toLowerCase()) return 'must be lower-case';
  let host = entry;
  const colon = entry.lastIndexOf(':');
  if (colon >= 0) {
    const port = entry.slice(colon + 1);
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return 'has an invalid port';
    if (port === '443') return 'must not write the default port 443 (write the host alone)';
    host = entry.slice(0, colon);
  }
  let wildcard = false;
  if (host.startsWith('*.')) {
    wildcard = true;
    host = host.slice(2);
  }
  const labels = host.split('.');
  if (host.length === 0 || host.length > 253 || labels.some((l) => !LABEL_RE.test(l))) {
    return 'must be a host name (letters, digits, hyphens; an international name in its xn-- form), without scheme or path';
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return 'must be a host name, not an IP address';
  if (wildcard && labels.length < 2) return 'a wildcard needs at least two labels after "*." (never a top-level domain)';
  return null;
}

/**
 * Whether a URL's host (lower-case host name, port, '' for 443) matches one
 * of `entries`. An entry with a port matches that port only. An entry
 * without one matches port 443 only (`allowedHosts`: a client on another
 * port is listed with it), or every port with `anyPort` (`deniedHosts`: a
 * denied host stays denied on whatever port its owner serves).
 */
export function hostListed (hostname: string, port: string, entries: string[], opts: { anyPort?: boolean } = {}): boolean {
  const p = port === '' || port === '443' ? '443' : port;
  for (const entry of entries) {
    if (hostEntryProblem(entry) != null) continue;
    const colon = entry.lastIndexOf(':');
    const entryHost = colon >= 0 ? entry.slice(0, colon) : entry;
    const entryPort = colon >= 0 ? entry.slice(colon + 1) : (opts.anyPort === true ? p : '443');
    if (entryPort !== p) continue;
    if (entryHost.startsWith('*.')) {
      const domain = entryHost.slice(1); // '.example.com'
      if (hostname.endsWith(domain)) {
        const label = hostname.slice(0, -domain.length);
        if (label.length > 0 && !label.includes('.')) return true;
      }
    } else if (hostname === entryHost) {
      return true;
    }
  }
  return false;
}

function hostListProblems (key: string, v: unknown, problems: string[]): void {
  if (v == null) return;
  if (!Array.isArray(v)) {
    problems.push(`oauth.clientMetadataDocuments.${key} must be a list of host names`);
    return;
  }
  if (v.length > MAX_HOST_ENTRIES) problems.push(`oauth.clientMetadataDocuments.${key} lists more than ${MAX_HOST_ENTRIES} hosts`);
  v.forEach((entry, i) => {
    const problem = hostEntryProblem(entry);
    if (problem != null) problems.push(`oauth.clientMetadataDocuments.${key}[${i}] ${JSON.stringify(entry)} ${problem}`);
  });
}

function templateProblems (raw: unknown, problems: string[]): void {
  const at = 'oauth.clientMetadataDocuments.client';
  if (!isPlainObject(raw)) {
    problems.push(`${at} is required: what a metadata-document client may be granted (scope, allowedAudiences, ...)`);
    return;
  }
  for (const k of Object.keys(raw)) {
    if (!TEMPLATE_KEYS.includes(k)) problems.push(`${at}.${k} is not a template setting (known: ${TEMPLATE_KEYS.join(', ')})`);
  }
  const scope = scopeTokens(raw.scope);
  if (scope == null) problems.push(`${at}.scope must be a space-separated scope string`);
  else if (scope.length === 0) problems.push(`${at}.scope is required: the maximum scope set, in the grammar of the installed OAuth extension`);
  const audiences = raw.allowedAudiences;
  if (!Array.isArray(audiences) || audiences.length === 0) {
    problems.push(`${at}.allowedAudiences is required: at least one resource URL such a client may name (aud / resource)`);
  } else {
    for (const a of audiences) {
      let u: URL | null = null;
      try { u = new URL(String(a)); } catch { u = null; }
      if (typeof a !== 'string' || u == null || u.protocol !== 'https:' || u.hash !== '' || u.username !== '' || u.password !== '') {
        problems.push(`${at}.allowedAudiences: ${JSON.stringify(a)} must be an absolute https URL without fragment or user information`);
      }
    }
  }
  if (raw.launchTypes != null && (!Array.isArray(raw.launchTypes) || raw.launchTypes.some((t) => typeof t !== 'string' || t.length === 0))) {
    problems.push(`${at}.launchTypes must be a list of non-empty strings`);
  }
  if (raw.subjectType != null && raw.subjectType !== 'public' && raw.subjectType !== 'pairwise') {
    problems.push(`${at}.subjectType must be pairwise or public`);
  }
  if (raw.maxEntries != null && !(Number.isInteger(raw.maxEntries) && (raw.maxEntries as number) >= 1 && (raw.maxEntries as number) <= MAX_TEMPLATE_ENTRIES)) {
    problems.push(`${at}.maxEntries must be an integer from 1 to ${MAX_TEMPLATE_ENTRIES}`);
  }
  if (raw.offlineAccessAllowed != null && typeof raw.offlineAccessAllowed !== 'boolean') {
    problems.push(`${at}.offlineAccessAllowed must be true or false`);
  }
  for (const k of ['accessTokenTTL', 'refreshTokenTTL', 'refreshTokenAbsoluteTTL']) {
    if (raw[k] != null && !isLifetime(raw[k])) problems.push(`${at}.${k} must be a positive number of seconds, or null`);
  }
  if (isLifetime(raw.refreshTokenTTL) && isLifetime(raw.refreshTokenAbsoluteTTL) && raw.refreshTokenTTL > raw.refreshTokenAbsoluteTTL) {
    problems.push(`${at}.refreshTokenTTL must not exceed refreshTokenAbsoluteTTL`);
  }
  if (raw.regions != null) {
    const regions = raw.regions;
    if (!Array.isArray(regions) || regions.length > MAX_REGIONS || regions.some((r) => typeof r !== 'string' || !REGION_KEY_RE.test(r))) {
      problems.push(`${at}.regions must be a list of at most ${MAX_REGIONS} region keys (letters, digits, ".", "_", "-")`);
    } else if (new Set(regions).size !== regions.length) {
      problems.push(`${at}.regions lists a region twice`);
    }
  }
}

/**
 * Problems (the boot refuses them) and warnings of an
 * `oauth.clientMetadataDocuments` block. Absent: the feature is off, nothing
 * to report. With `mode: off` the rest is not checked (a half-written block
 * does not stop the boot); a warning names what is set but not used.
 */
export function describeClientMetadataConfig (raw: unknown): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (raw == null) return { problems, warnings };
  if (!isPlainObject(raw)) {
    problems.push('oauth.clientMetadataDocuments must be an object (mode, allowedHosts, ..., client)');
    return { problems, warnings };
  }
  const mode = parseMode(raw.mode);
  if (mode == null) {
    problems.push(`oauth.clientMetadataDocuments.mode is ${JSON.stringify(raw.mode)}: off, allowList or any is expected`);
    return { problems, warnings };
  }
  if (mode === 'off') {
    const t = isPlainObject(raw.client) ? raw.client : {};
    const set: string[] = [];
    if (Array.isArray(raw.allowedHosts) && raw.allowedHosts.length > 0) set.push('allowedHosts');
    if (Array.isArray(raw.deniedHosts) && raw.deniedHosts.length > 0) set.push('deniedHosts');
    if ((scopeTokens(t.scope) ?? ['?']).length > 0) set.push('client.scope');
    if (Array.isArray(t.allowedAudiences) && t.allowedAudiences.length > 0) set.push('client.allowedAudiences');
    if (set.length > 0) {
      warnings.push(`'oauth.clientMetadataDocuments' is off (mode: off): ${set.join(', ')} ${set.length > 1 ? 'are' : 'is'} set but not used.`);
    }
    return { problems, warnings };
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) problems.push(`oauth.clientMetadataDocuments.${k} is not a setting (known: ${TOP_KEYS.join(', ')})`);
  }
  hostListProblems('allowedHosts', raw.allowedHosts, problems);
  hostListProblems('deniedHosts', raw.deniedHosts, problems);
  if (mode === 'allowList' && !(Array.isArray(raw.allowedHosts) && raw.allowedHosts.length > 0)) {
    problems.push('oauth.clientMetadataDocuments.allowedHosts is empty with mode: allowList: nothing would be accepted (list the hosts, or set mode: off)');
  }
  for (const [k, [min, max]] of Object.entries(NUMBER_BOUNDS)) {
    const v = raw[k];
    if (v != null && !(Number.isInteger(v) && (v as number) >= min && (v as number) <= max)) {
      problems.push(`oauth.clientMetadataDocuments.${k} must be an integer from ${min} to ${max}`);
    }
  }
  const methods = raw.authMethods;
  if (methods != null) {
    if (!Array.isArray(methods) || methods.length === 0 || methods.some((m) => !METADATA_AUTH_METHODS.includes(m as string))) {
      problems.push(`oauth.clientMetadataDocuments.authMethods must be a non-empty list of ${METADATA_AUTH_METHODS.join(', ')}`);
    } else if (new Set(methods).size !== methods.length) {
      problems.push('oauth.clientMetadataDocuments.authMethods lists a method twice');
    }
  }
  templateProblems(raw.client, problems);
  if (mode === 'any') {
    warnings.push("'oauth.clientMetadataDocuments.mode' is any: any party on the internet can present a client to the consent screen " +
      '(the host shown next to the name, the template and the deny-list are the controls); allowList is the cautious setting.');
  }
  return { problems, warnings };
}

let memo: { key: string; settings: ClientMetadataSettings } | null = null;

/**
 * The settings in force: the block read from the configuration, with the
 * defaults. A block with problems (the boot refuses it) reads as `off`, so
 * nothing is fetched on its account.
 */
export function clientMetadataSettings (config: { get (key: string): unknown }): ClientMetadataSettings {
  const raw = config.get('oauth:clientMetadataDocuments');
  let key: string;
  try { key = JSON.stringify(raw ?? null); } catch { key = ''; }
  if (memo != null && memo.key === key && key !== '') return memo.settings;
  const settings = buildSettings(raw);
  memo = { key, settings };
  return settings;
}

function buildSettings (raw: unknown): ClientMetadataSettings {
  const d = DEFAULT_CLIENT_METADATA_SETTINGS;
  const off: ClientMetadataSettings = { ...d, allowedHosts: [], deniedHosts: [], authMethods: [...d.authMethods], client: { ...d.client } };
  if (!isPlainObject(raw)) return off;
  const mode = parseMode(raw.mode);
  if (mode == null || mode === 'off') return off;
  if (describeClientMetadataConfig(raw).problems.length > 0) return off;
  const num = (k: string, fallback: number): number => (Number.isInteger(raw[k]) ? raw[k] as number : fallback);
  const t = raw.client as Record<string, unknown>;
  const life = (k: string): number | null => (isLifetime(t[k]) ? t[k] as number : null);
  return {
    mode,
    allowedHosts: Array.isArray(raw.allowedHosts) ? [...raw.allowedHosts as string[]] : [],
    deniedHosts: Array.isArray(raw.deniedHosts) ? [...raw.deniedHosts as string[]] : [],
    cacheSeconds: num('cacheSeconds', d.cacheSeconds),
    staleGraceSeconds: num('staleGraceSeconds', d.staleGraceSeconds),
    negativeCacheSeconds: num('negativeCacheSeconds', d.negativeCacheSeconds),
    fetchTimeoutMs: num('fetchTimeoutMs', d.fetchTimeoutMs),
    maxDocumentBytes: num('maxDocumentBytes', d.maxDocumentBytes),
    fetchesPerMinute: num('fetchesPerMinute', d.fetchesPerMinute),
    fetchesPerMinutePerHost: d.fetchesPerMinutePerHost,
    authMethods: Array.isArray(raw.authMethods) ? [...raw.authMethods as string[]] : [...d.authMethods],
    client: {
      scope: scopeTokens(t.scope) ?? [],
      allowedAudiences: [...t.allowedAudiences as string[]],
      launchTypes: Array.isArray(t.launchTypes) ? [...t.launchTypes as string[]] : [],
      subjectType: t.subjectType === 'public' ? 'public' : 'pairwise',
      maxEntries: Number.isInteger(t.maxEntries) ? t.maxEntries as number : d.client.maxEntries,
      offlineAccessAllowed: t.offlineAccessAllowed !== false,
      accessTokenTTL: life('accessTokenTTL'),
      refreshTokenTTL: life('refreshTokenTTL'),
      refreshTokenAbsoluteTTL: life('refreshTokenAbsoluteTTL'),
      regions: Array.isArray(t.regions) ? [...t.regions as string[]] : [],
    },
  };
}

/** Whether client metadata documents are accepted on this core. */
export function clientMetadataDocumentsOn (config: { get (key: string): unknown }): boolean {
  return clientMetadataSettings(config).mode !== 'off';
}
