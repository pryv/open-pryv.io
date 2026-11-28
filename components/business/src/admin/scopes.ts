/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Scopes of administrator grants: where a grant counts.
 *
 *   platform                every core
 *   region:<id>             the cores whose hosting is in that region of `hostings`
 *   zone:<id>               the cores whose hosting is in that zone
 *   hosting:<id>            the cores of that hosting (`core.hosting`, `default` when unset)
 *   core:<id>               that core
 *
 * An id is 1 to 128 of `A-Z a-z 0-9 . _ -`. An id that the `hostings`
 * hierarchy (regions > zones > hostings) or the core list does not know never
 * matches: such a grant is an orphan and gives nothing. Without a `hostings`
 * hierarchy only `platform`, `hosting:default` and `core:<id>` can match.
 */

type ConfigReader = { get: (key: string) => unknown };

export const SCOPE_PLATFORM = 'platform';
/** The hosting of a core with no `core.hosting` (as the platform layer names it). */
export const DEFAULT_HOSTING = 'default';

export type ScopeKind = 'platform' | 'region' | 'zone' | 'hosting' | 'core';
export type ParsedScope =
  | { kind: 'platform' }
  | { kind: 'region' | 'zone' | 'hosting' | 'core'; id: string };

const SCOPE_RE = /^(region|zone|hosting|core):([A-Za-z0-9._-]{1,128})$/;

/** The parts of a scope, or null when it does not follow the grammar. */
export function parseScope (scope: unknown): ParsedScope | null {
  if (scope === SCOPE_PLATFORM) return { kind: 'platform' };
  if (typeof scope !== 'string') return null;
  const m = SCOPE_RE.exec(scope);
  if (m == null) return null;
  return { kind: m[1] as 'region' | 'zone' | 'hosting' | 'core', id: m[2] };
}

/** Whether a value follows the scope grammar (it may still be an orphan). */
export function isScope (scope: unknown): scope is string {
  return parseScope(scope) != null;
}

type ZoneNode = { hostings?: unknown };
type RegionNode = { zones?: unknown };
/** The `hostings` hierarchy: region key > zone key > hosting key. */
export type Hostings = { regions: Record<string, RegionNode> };

function isObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** The `hostings` hierarchy of the configuration, or null when the platform declares none. */
export function hostingsOf (config: ConfigReader): Hostings | null {
  const raw = config.get('hostings');
  if (!isObject(raw) || !isObject(raw.regions)) return null;
  return raw as Hostings;
}

/** Own keys of an object node (never inherited ones). */
function keysOf (node: unknown): string[] {
  return isObject(node) ? Object.keys(node) : [];
}

function childOf (node: unknown, key: string): unknown {
  return isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
}

/** The region and zone holding a hosting, or null when the hierarchy does not list it. */
export function placeHosting (hostings: Hostings | null, hosting: string): { region: string; zone: string } | null {
  if (hostings == null) return null;
  for (const region of keysOf(hostings.regions)) {
    const zones = (childOf(hostings.regions, region) as RegionNode | undefined)?.zones;
    for (const zone of keysOf(zones)) {
      const hostingsOfZone = (childOf(zones, zone) as ZoneNode | undefined)?.hostings;
      if (isObject(hostingsOfZone) && Object.hasOwn(hostingsOfZone, hosting)) return { region, zone };
    }
  }
  return null;
}

/**
 * Problems of the `hostings` hierarchy for grant scopes: a zone key listed
 * in two regions, or a hosting key listed in two zones, would make
 * `zone:<id>` or `hosting:<id>` (and the place of a core) ambiguous. Never
 * throws; problems name their key path.
 */
export function describeHostings (config: ConfigReader): Array<{ message: string; path: string[] }> {
  const problems: Array<{ message: string; path: string[] }> = [];
  const hostings = hostingsOf(config);
  if (hostings == null) return problems;
  const zoneSeen = new Map<string, string>();
  const hostingSeen = new Map<string, string>();
  for (const region of keysOf(hostings.regions)) {
    const zones = (childOf(hostings.regions, region) as RegionNode | undefined)?.zones;
    for (const zone of keysOf(zones)) {
      const path = ['hostings', 'regions', region, 'zones', zone];
      const firstRegion = zoneSeen.get(zone);
      if (firstRegion != null) {
        problems.push({ message: `${path.join('.')} uses the zone key '${zone}' of region '${firstRegion}' too: zone keys must be unique across regions (administrator grant scopes name a zone by its key)`, path });
      } else {
        zoneSeen.set(zone, region);
      }
      for (const hosting of keysOf((childOf(zones, zone) as ZoneNode | undefined)?.hostings)) {
        const where = `${region}.${zone}`;
        const first = hostingSeen.get(hosting);
        if (first != null) {
          problems.push({ message: `${path.join('.')}.hostings.${hosting} is also listed under ${first}: hosting keys must be unique across the hierarchy`, path: [...path, 'hostings', hosting] });
        } else {
          hostingSeen.set(hosting, where);
        }
      }
    }
  }
  return problems;
}

/** The region keys of the hierarchy. */
export function regionsOf (hostings: Hostings | null): string[] {
  return hostings == null ? [] : keysOf(hostings.regions);
}

function hasZone (hostings: Hostings | null, zone: string): boolean {
  if (hostings == null) return false;
  return keysOf(hostings.regions).some((r) => childOf((childOf(hostings.regions, r) as RegionNode | undefined)?.zones, zone) !== undefined);
}

/** Where this core sits: what its grants' scopes are matched against. */
export type CoreContext = {
  coreId: string;
  /** `core.hosting`, `default` when unset. */
  hosting: string;
  /** Null when the platform has no hierarchy or the hierarchy does not list the hosting. */
  zone: string | null;
  region: string | null;
  /** The region keys the hierarchy knows (empty without one). */
  regions: readonly string[];
  /** Whether the platform declares a `hostings` hierarchy. */
  hierarchy: boolean;
};

/** The hosting key of this core (`core.hosting`, `default` when unset). */
export function hostingOf (config: ConfigReader): string {
  const h = config.get('core:hosting');
  return typeof h === 'string' && h !== '' ? h : DEFAULT_HOSTING;
}

/** This core's place, from `core.id`, `core.hosting` and `hostings`. */
export function coreContext (config: ConfigReader): CoreContext {
  const id = config.get('core:id');
  const hosting = hostingOf(config);
  const hostings = hostingsOf(config);
  const place = placeHosting(hostings, hosting);
  return {
    coreId: typeof id === 'string' && id !== '' ? id : 'single',
    hosting,
    zone: place?.zone ?? null,
    region: place?.region ?? null,
    regions: regionsOf(hostings),
    hierarchy: hostings != null
  };
}

/** Whether a grant of this scope counts on the core of `ctx`. An invalid scope covers nothing. */
export function scopeCoversCore (scope: unknown, ctx: CoreContext): boolean {
  const s = parseScope(scope);
  if (s == null) return false;
  switch (s.kind) {
    case 'platform': return true;
    case 'core': return s.id === ctx.coreId;
    case 'region': return ctx.region != null && s.id === ctx.region;
    case 'zone': return ctx.zone != null && s.id === ctx.zone;
    case 'hosting':
      // In a hierarchy, a hosting it lists; without one, only `default`.
      return s.id === ctx.hosting && (ctx.hierarchy ? ctx.zone != null : s.id === DEFAULT_HOSTING);
  }
  return false;
}

/**
 * Whether a grant of this scope covers every region of `regions` (an OAuth
 * client's or a publisher's regions): `platform` always; `region:<r>` when the
 * hierarchy knows `r` and every listed region is `r`. A row without regions
 * (all regions) needs `platform`. Other scopes never do.
 */
export function scopeCoversRegions (scope: unknown, regions: readonly string[] | null | undefined, hostings: Hostings | null): boolean {
  const s = parseScope(scope);
  if (s == null) return false;
  if (s.kind === 'platform') return true;
  if (s.kind !== 'region') return false;
  if (!regionsOf(hostings).includes(s.id)) return false;
  if (!Array.isArray(regions) || regions.length === 0) return false;
  return regions.every((r) => r === s.id);
}

export type ScopeState = 'ok' | 'orphan';

/**
 * Whether a scope names something the platform knows: `ok`, or `orphan` (it
 * matches no core; an invalid scope is an orphan too).
 */
export function scopeState (scope: unknown, hostings: Hostings | null, coreIds: readonly string[]): ScopeState {
  const s = parseScope(scope);
  if (s == null) return 'orphan';
  switch (s.kind) {
    case 'platform': return 'ok';
    case 'core': return coreIds.includes(s.id) ? 'ok' : 'orphan';
    case 'region': return regionsOf(hostings).includes(s.id) ? 'ok' : 'orphan';
    case 'zone': return hasZone(hostings, s.id) ? 'ok' : 'orphan';
    case 'hosting':
      if (hostings == null) return s.id === DEFAULT_HOSTING ? 'ok' : 'orphan';
      return placeHosting(hostings, s.id) != null ? 'ok' : 'orphan';
  }
  return 'orphan';
}
