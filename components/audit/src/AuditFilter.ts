/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const validation = require('./validation.ts');

type FilterEntry = { syslog?: true; storage?: true; platformTrail?: true; platformTrailValidOnly?: true; platformTrailAdminOnly?: true } | false;
type FilterParam = { methods: { include: string[]; exclude: string[] } };

const {
  ALL_METHODS,
  AUDITED_METHODS,
  WITH_USER_METHODS,
  WITHOUT_USER_METHODS
} = require('./ApiMethods.ts');

/**
 * Public ids that are an administration act when an administrator makes the
 * call: an account erased with the admin key (`DELETE /users/:username`).
 * Selected through `admin-acts`, a call is kept in the platform trail only
 * when its record names an administrator as its subject (a deletion by the
 * account's holder is not an administration act); naming the id (or `all`)
 * keeps every call.
 */
export const ADMIN_SUBJECT_METHODS: readonly string[] = Object.freeze(['auth.delete']);
/**
 * The group naming the administration acts in a filter: the audited calls
 * without an account of the core whose id starts with `system.` (the /system
 * methods and routes) or `admin.`, and `ADMIN_SUBJECT_METHODS`. The default
 * of `audit.platformTrail.filter`.
 */
export const ADMIN_ACTS = 'admin-acts';
const PLATFORM_TRAIL_BASE: string[] = AUDITED_METHODS.filter((m: string) => WITHOUT_USER_METHODS.includes(m));
export const ADMIN_ACT_METHODS: readonly string[] = Object.freeze(PLATFORM_TRAIL_BASE.filter((m) => m.startsWith('system.') || m.startsWith('admin.') || ADMIN_SUBJECT_METHODS.includes(m)));
/**
 * Administration ids an unauthenticated caller can reach (a setup code tried,
 * an account deletion without a credential): selected through `admin-acts`,
 * only their done calls are kept in the platform trail; naming them (or
 * `all`) keeps their refusals too.
 */
export const PUBLIC_REFUSAL_METHODS: readonly string[] = Object.freeze(['system.setup.createSession', 'auth.delete']);
/** The subjects (`content.record.subject.via`) of an administrator. */
export const ADMIN_SUBJECT_VIAS: readonly string[] = Object.freeze(['admin-key', 'session', 'setup']);
export const DEFAULT_PLATFORM_TRAIL_FILTER: FilterParam = Object.freeze({ methods: Object.freeze({ include: [ADMIN_ACTS], exclude: [] }) }) as FilterParam;

class AuditFilter {
  /**
   * Map with items:
   * method.id => { syslog: true, storage: true, platformTrail: true } if any of them is audited
   * method.id => false if none is audited
   * `storage`: kept in the account's own trail (methods with a user,
   * `audit:storage:filter`); `platformTrail`: kept in the trail of this core's
   * acts (methods without a user), when both `audit:platformTrail:filter`
   * (default: the administration acts) and `audit:storage:filter` select it;
   * `platformTrailValidOnly`: its refused calls are not kept there;
   * `platformTrailAdminOnly`: kept there only when its record names an
   * administrator as its subject (`ADMIN_SUBJECT_METHODS`).
   */
  filter: { methods: Record<string, FilterEntry> };

  /**
   * Builds the syslogFilter & storageFilter maps used by the filter.
   * Throws an error if the config audit:syslog:filter, audit:storage:filter or audit:platformTrail:filter parameters are invalid
   */
  constructor (
    params: { syslogFilter: FilterParam; storageFilter: FilterParam; platformTrailFilter?: FilterParam | null } = {
      syslogFilter: { methods: { include: ['all'], exclude: [] } },
      storageFilter: { methods: { include: ['all'], exclude: [] } }
    }
  ) {
    const syslogFilterParam = params.syslogFilter;
    const storageFilterParam = params.storageFilter;
    const platformTrailParam = params.platformTrailFilter ?? DEFAULT_PLATFORM_TRAIL_FILTER;

    validation.filter(syslogFilterParam);
    validation.filter(storageFilterParam);
    validation.filter(platformTrailParam);

    const syslogFilter = {
      methods: buildIncludeMap(
        AUDITED_METHODS,
        syslogFilterParam.methods.include,
        syslogFilterParam.methods.exclude
      )
    };
    const storageFilter = {
      methods: buildIncludeMap(
        WITH_USER_METHODS,
        storageFilterParam.methods.include,
        storageFilterParam.methods.exclude
      )
    };
    const storedWithoutUser = buildIncludeMap(PLATFORM_TRAIL_BASE, storageFilterParam.methods.include, storageFilterParam.methods.exclude);
    const platformTrailSelected = buildIncludeMap(PLATFORM_TRAIL_BASE, platformTrailParam.methods.include, platformTrailParam.methods.exclude);
    // Named (by id, a family `x.all`, or `all`) rather than through the group.
    const namedInclude = expandAggregates(platformTrailParam.methods.include.filter((m: string) => m !== ADMIN_ACTS));
    const isNamed = (m: string) => hasAll(namedInclude) || namedInclude.includes(m);
    const methodsFullFilter: Record<string, FilterEntry> = {};
    for (let i = 0; i < ALL_METHODS.length; i++) {
      const m = ALL_METHODS[i];
      let methodFilter: { syslog?: true; storage?: true; platformTrail?: true; platformTrailValidOnly?: true; platformTrailAdminOnly?: true } | false = {};
      if (syslogFilter.methods[m]) methodFilter.syslog = true;
      if (storageFilter.methods[m]) methodFilter.storage = true;
      if (storedWithoutUser[m] && platformTrailSelected[m]) {
        methodFilter.platformTrail = true;
        if (PUBLIC_REFUSAL_METHODS.includes(m) && !isNamed(m)) methodFilter.platformTrailValidOnly = true;
        if (ADMIN_SUBJECT_METHODS.includes(m) && !isNamed(m)) methodFilter.platformTrailAdminOnly = true;
      }
      if (Object.keys(methodFilter).length === 0) methodFilter = false;
      methodsFullFilter[m] = methodFilter;
    }

    this.filter = { methods: methodsFullFilter };

    function buildIncludeMap (baseMethods: string[], include: string[], exclude: string[]) {
      include = expandAggregates(include);
      exclude = expandAggregates(exclude);

      if (isOnlyIncludeUsed(include, exclude)) {
        // only include
        if (hasAll(include)) {
          return buildMap(baseMethods);
        } else {
          return buildMap(baseMethods.filter((m: string) => include.includes(m)));
        }
      } else if (isOnlyExcludeUsed(include, exclude)) {
        // only exclude
        if (hasAll(exclude)) {
          return {};
        } else {
          return buildMap(baseMethods.filter((m: string) => !exclude.includes(m)));
        }
      } else {
        // both included and excluded: what `include` selects (every method
        // for "all"), less what `exclude` names. "all" on both sides selects
        // nothing.
        if (hasAll(include) && hasAll(exclude)) return {};
        const included = hasAll(include) ? baseMethods : baseMethods.filter((m: string) => include.includes(m));
        return buildMap(included.filter((m: string) => !exclude.includes(m)));
      }
    }

    function isOnlyIncludeUsed (include: string[], exclude: string[]) {
      return include.length > 0 && exclude.length === 0;
    }
    function isOnlyExcludeUsed (include: string[], exclude: string[]) {
      return exclude.length > 0 && include.length === 0;
    }
    function hasAll (methods: string[]) {
      return methods.includes('all');
    }
    function expandAggregates (methods: string[]) {
      let expandedMethods: string[] = [];
      methods.forEach((m: string) => {
        if (m === ADMIN_ACTS) {
          expandedMethods = expandedMethods.concat(ADMIN_ACT_METHODS);
        } else if (!isAggregate(m)) {
          expandedMethods.push(m);
        } else {
          expandedMethods = expandedMethods.concat(expandAggregate(m));
        }
      });
      return expandedMethods;

      function isAggregate (m: string) {
        const parts = m.split('.');
        if (parts.length !== 2) return false;
        if (parts[1] !== 'all') return false;
        return true;
      }
      function expandAggregate (aggregateMethod: string) {
        const resource = aggregateMethod.split('.')[0];
        const expandedMethod: string[] = [];
        ALL_METHODS.forEach((m: string) => {
          if (m.startsWith(resource + '.')) expandedMethod.push(m);
        });
        return expandedMethod;
      }
    }
    /**
     * Builds a map with an { i => true } entry for each array element
     */
    function buildMap (array: string[]) {
      const map: Record<string, true> = {};
      array.forEach((i: string) => {
        map[i] = true;
      });
      return map;
    }
  }

  /**
   * Returns { syslog?: true, storage?: true } if at least one of them is audited
   * otherwise, returns false
   * @param method - the method name. Ex.: events.get
   */
  isAudited (method: string) {
    return this.filter.methods[method];
  }
}
export default AuditFilter;
export { AuditFilter };
