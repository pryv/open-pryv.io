/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The effective configuration document of a running core: every key in
 * force, where it comes from, secrets redacted, and two digests for drift
 * comparison (`platform`: keys expected identical on every core; `full`: all
 * keys). Pure functions over the configuration layers, so they run without
 * a server.
 *
 * What is reported: only the top-level sections of `default-config.yml` plus
 * EXTRA_TOP_LEVEL_KEYS. Any other top-level key (every ambient environment
 * variable, command-line flags, values derived at boot) is left out
 * entirely; unknown top-level keys written in the operator's configuration
 * files are listed by name only (`unknownTopLevelKeys`).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { EXTRA_TOP_LEVEL_KEYS, findRule, isNameException, pathLooksSecret, type Rule, type RuleScope } from './classification.ts';
import {
  fingerprint, fingerprintKey, MAX_STRING_LENGTH, redactedEntry, sanitizeUrl, secretNeedles, stableStringify,
  stringLooksSecret, urlOrigin, type RedactedEntry, type RedactionClass
} from './redact.ts';

export const FORMAT = 'pryv-effective-config/1';
const MAX_DEPTH = 12;
const FILE_SCOPES = ['override-file', 'bootstrap-file', 'base'];

export type ConfigScope = { name: string, tree: Record<string, unknown>, file?: string };
export type ObservabilityOrigin = 'local' | 'db' | 'default';
export type ObservabilityResolution = {
  values: {
    enabled: boolean,
    provider: string,
    appName: string,
    logLevel: string,
    otlp: { endpoint: string, headers: Record<string, string>, flushIntervalSeconds: number | null }
  },
  origins: Record<string, ObservabilityOrigin>
};
export type SnapshotInput = {
  /** Configuration layers, highest priority first. */
  scopes: ConfigScope[],
  /** The merged value of a top-level key, as the server reads it. */
  merged: (topKey: string) => unknown,
  observability?: ObservabilityResolution | null,
  coreId: string,
  apiVersion: string,
  now?: Date
};
export type ShownEntry = { value: unknown, sanitized?: true };
export type KeyEntry = (ShownEntry | RedactedEntry) & { source: string, scope: RuleScope };
export type ConfigMeta = {
  format: string,
  coreId: string,
  apiVersion: string,
  snapshotAt: string,
  digestAlgorithm: 'sha256',
  digests: { full: string, platform: string },
  secretFingerprints: boolean,
  sourceFiles: Record<string, string>,
  unknownTopLevelKeys: string[]
};
export type EffectiveConfig = { configMeta: ConfigMeta, keys: Record<string, KeyEntry> };

type Leaf = { segments: string[], value: unknown, rule: Rule | null, kind: RedactionClass | 'public' | 'url-origin' };

const SCOPE_LABELS: Record<string, string> = {
  memory: 'derived',
  'override-file': 'override-file',
  'bootstrap-file': 'bootstrap-file',
  test: 'test',
  argv: 'argv',
  env: 'env',
  base: 'base-file',
  serviceInfo: 'service-info',
  'default-paths': 'shipped-plugin',
  'defaults-paths': 'shipped-plugin',
  'default-audit-path': 'shipped-plugin',
  'default-file': 'default-file',
  defaults: 'built-in'
};

const OBSERVABILITY_PATHS: Record<string, string[]> = {
  enabled: ['observability', 'enabled'],
  provider: ['observability', 'provider'],
  appName: ['observability', 'appName'],
  logLevel: ['observability', 'logLevel'],
  endpoint: ['observability', 'otlp', 'endpoint'],
  headers: ['observability', 'otlp', 'headers'],
  flushIntervalSeconds: ['observability', 'otlp', 'flushIntervalSeconds']
};

/** The layers of a boiler (nconf) configuration, highest priority first. */
export function scopesFromStores (stores: Record<string, { store?: unknown, type?: string, file?: string }>): ConfigScope[] {
  return Object.entries(stores).map(([name, s]) => {
    const tree = (s.store != null && typeof s.store === 'object') ? s.store as Record<string, unknown> : {};
    const scope: ConfigScope = { name, tree };
    if (s.type === 'file' && typeof s.file === 'string') scope.file = s.file;
    return scope;
  });
}

/** Dotted path of segments; `.` and `\` inside a segment are escaped. */
export function encodePath (segments: readonly string[]): string {
  return segments.map((s) => s.replace(/\\/g, '\\\\').replace(/\./g, '\\.')).join('.');
}

export function buildEffectiveConfig (input: SnapshotInput): EffectiveConfig {
  const scopes = input.scopes;
  const defaultTree = scopes.find((s) => s.name === 'default-file')?.tree ?? {};
  const knownTop = new Set<string>([...Object.keys(defaultTree), ...EXTRA_TOP_LEVEL_KEYS]);

  const unknown = new Set<string>();
  for (const scope of scopes) {
    if (!FILE_SCOPES.includes(scope.name)) continue;
    for (const k of Object.keys(scope.tree)) if (!knownTop.has(k)) unknown.add(k);
  }

  // 1. collect the leaves of every known section
  const leaves: Leaf[] = [];
  const sourceOverrides = new Map<string, string>();
  for (const top of [...knownTop].sort()) {
    let value = input.merged(top);
    if (value === undefined) continue;
    if (top === 'observability' && input.observability != null) {
      value = overlayObservability(value, input.observability, sourceOverrides);
    }
    walk(value, [top], new Set(), 0, defaultTree, leaves);
  }

  // 2. live secrets, searched for inside every shown string
  const needles = secretNeedles(leaves.filter((l) => l.kind === 'secret' || l.kind === 'opaque').map((l) => l.value));
  const auth = input.merged('auth');
  const fpKey = fingerprintKey(isPlainObject(auth) ? auth.filesReadTokenSecret : undefined);

  // 3. entries
  const keys: Record<string, KeyEntry> = Object.create(null);
  for (const leaf of leaves.sort((a, b) => compareStrings(encodePath(a.segments), encodePath(b.segments)))) {
    const encoded = encodePath(leaf.segments);
    const entry = toEntry(leaf, encoded, needles, fpKey);
    const source = sourceOverrides.get(encoded) ?? findSource(scopes, leaf.segments);
    keys[encoded] = Object.assign(entry, { source, scope: leaf.rule?.scope ?? 'platform' }) as KeyEntry;
  }

  const sourceFiles: Record<string, string> = {};
  for (const scope of scopes) {
    if (scope.file != null) sourceFiles[SCOPE_LABELS[scope.name] ?? 'scope:' + scope.name] = path.basename(scope.file);
  }

  return {
    configMeta: {
      format: FORMAT,
      coreId: input.coreId,
      apiVersion: input.apiVersion,
      snapshotAt: (input.now ?? new Date()).toISOString(),
      digestAlgorithm: 'sha256',
      digests: computeDigests(keys),
      secretFingerprints: fpKey != null,
      sourceFiles,
      unknownTopLevelKeys: [...unknown].sort()
    },
    keys
  };
}

/**
 * `sha256(stableStringify({ format, keys }))`, where `keys` holds each entry
 * without `source` and `scope`: `full` over every key, `platform` over the
 * keys of scope `platform`. Anyone holding the document can recompute them.
 */
export function computeDigests (keys: Record<string, KeyEntry>): { full: string, platform: string } {
  const full: Record<string, unknown> = Object.create(null);
  const platform: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(keys)) {
    const { source: _source, scope, ...rest } = keys[k];
    full[k] = rest;
    if (scope === 'platform') platform[k] = rest;
  }
  return { full: sha256(stableStringify({ format: FORMAT, keys: full })), platform: sha256(stableStringify({ format: FORMAT, keys: platform })) };
}

function sha256 (s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function compareStrings (a: string, b: string): number {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function isPlainObject (v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isSupportedScalar (v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  return t === 'number' && Number.isFinite(v as number);
}

function getOwn (tree: unknown, segments: readonly string[]): { found: boolean, value?: unknown } {
  let cur: unknown = tree;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: cur !== undefined, value: cur };
}

function walk (node: unknown, segments: string[], ancestors: Set<unknown>, depth: number, defaultTree: Record<string, unknown>, out: Leaf[]): void {
  const rule = findRule(segments);
  if (node === undefined) return;
  const isObj = isPlainObject(node);
  const isArr = Array.isArray(node);
  if (depth > MAX_DEPTH || (!isObj && !isArr && !isSupportedScalar(node)) || ((isObj || isArr) && ancestors.has(node))) {
    out.push({ segments, value: node, rule, kind: 'unsupported-type' });
    return;
  }
  if (rule != null && (rule.class === 'secret' || rule.class === 'opaque')) {
    out.push({ segments, value: node, rule, kind: rule.class });
    return;
  }
  const def = getOwn(defaultTree, segments);
  if (def.found && def.value !== null) {
    const defIsObj = isPlainObject(def.value);
    if ((defIsObj && !isObj && !isArr && node !== null) || (!defIsObj && !Array.isArray(def.value) && isObj)) {
      out.push({ segments, value: node, rule, kind: 'shape-mismatch' });
      return;
    }
  }
  if (isObj && Object.keys(node).length > 0) {
    ancestors.add(node);
    for (const k of Object.keys(node)) walk(node[k], [...segments, k], ancestors, depth + 1, defaultTree, out);
    ancestors.delete(node);
    return;
  }
  if (isArr && (node as unknown[]).some((x) => x !== null && typeof x === 'object')) {
    ancestors.add(node);
    (node as unknown[]).forEach((x, i) => walk(x, [...segments, String(i)], ancestors, depth + 1, defaultTree, out));
    ancestors.delete(node);
    return;
  }
  out.push({ segments, value: node, rule, kind: rule == null ? 'unclassified' : rule.class });
}

function toEntry (leaf: Leaf, encoded: string, needles: readonly string[], fpKey: Buffer | null): ShownEntry | RedactedEntry {
  const value = leaf.value;
  switch (leaf.kind) {
    case 'secret':
    case 'opaque': {
      const fp = (fpKey != null && encoded !== 'auth.filesReadTokenSecret') ? fingerprint(fpKey, encoded, value) : null;
      return redactedEntry(leaf.kind, value, { size: leaf.kind === 'opaque' || encoded === 'invitationTokens', fingerprint: fp });
    }
    case 'public':
    case 'url-origin':
      break;
    default:
      return redactedEntry(leaf.kind, value);
  }
  if (pathLooksSecret(leaf.segments) && !isNameException(leaf.segments)) return redactedEntry('unclassified', value);
  const originOnly = leaf.kind === 'url-origin';
  if (typeof value === 'string') return showString(value, originOnly, needles);
  if (Array.isArray(value)) {
    let sanitized = false;
    const shown: unknown[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        if (!isSupportedScalar(item)) return redactedEntry('unsupported-type', value);
        shown.push(item);
        continue;
      }
      const e = showString(item, originOnly, needles);
      if ('redacted' in e) return redactedEntry(e.class, value);
      if (e.sanitized === true) sanitized = true;
      shown.push(e.value);
    }
    return sanitized ? { value: shown, sanitized: true } : { value: shown };
  }
  return { value };
}

function showString (s: string, originOnly: boolean, needles: readonly string[]): ShownEntry | RedactedEntry {
  if (s.length > MAX_STRING_LENGTH) return redactedEntry('unsupported-type', s);
  if (stringLooksSecret(s, needles)) return redactedEntry('value-pattern', s);
  if (originOnly) {
    const origin = urlOrigin(s);
    if (origin != null) return origin === s ? { value: s } : { value: origin, sanitized: true };
  }
  const url = sanitizeUrl(s);
  if (url != null && url.sanitized) return { value: url.value, sanitized: true };
  return { value: s };
}

function findSource (scopes: readonly ConfigScope[], segments: readonly string[]): string {
  for (const scope of scopes) {
    if (getOwn(scope.tree, segments).found) return SCOPE_LABELS[scope.name] ?? 'scope:' + scope.name;
  }
  return 'derived';
}

/**
 * The observability keys as the server resolves them (PlatformDB rows over
 * the files for some of them), with their origin: `db` reads `platform-db`,
 * `default` reads `derived`, `local` keeps the file layer that holds it.
 */
function overlayObservability (value: unknown, resolution: ObservabilityResolution, sourceOverrides: Map<string, string>): unknown {
  const tree: Record<string, unknown> = isPlainObject(value) ? { ...value } : {};
  const otlp: Record<string, unknown> = isPlainObject(tree.otlp) ? { ...tree.otlp } : {};
  tree.otlp = otlp;
  const v = resolution.values;
  const resolved: Record<string, unknown> = {
    enabled: v.enabled,
    provider: v.provider,
    appName: v.appName,
    logLevel: v.logLevel,
    endpoint: v.otlp.endpoint,
    headers: v.otlp.headers,
    flushIntervalSeconds: v.otlp.flushIntervalSeconds
  };
  for (const name of Object.keys(OBSERVABILITY_PATHS)) {
    const origin = resolution.origins[name] ?? 'default';
    if (resolved[name] == null) continue;
    const segs = OBSERVABILITY_PATHS[name];
    const target = segs.length === 3 ? otlp : tree;
    target[segs[segs.length - 1]] = resolved[name];
    if (origin === 'db') sourceOverrides.set(encodePath(segs), 'platform-db');
    else if (origin === 'default') sourceOverrides.set(encodePath(segs), 'derived');
  }
  return tree;
}
