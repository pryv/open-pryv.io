/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global validation, assert, apiMethods, AuditFilter */

describe('[AFLT] AuditFilter', () => {
  function buildFilter (include = ['all'], exclude = []) {
    return {
      methods: {
        include,
        exclude
      }
    };
  }
  describe('[AFPF] platform trail filter (calls without an account)', () => {
    const all = buildFilter();
    const make = (platformTrailFilter, storageFilter = all) => new AuditFilter({ syslogFilter: all, storageFilter, platformTrailFilter });
    it('[AFPT1] by default: the administration acts only, refused setup codes out; public traffic in syslog only', () => {
      const f = make(undefined);
      assert.deepStrictEqual(f.isAudited('system.roles.set'), { syslog: true, platformTrail: true });
      assert.deepStrictEqual(f.isAudited('system.users.delete'), { syslog: true, platformTrail: true }, 'a /system handler id');
      assert.deepStrictEqual(f.isAudited('system.setup.createSession'), { syslog: true, platformTrail: true, platformTrailValidOnly: true });
      // Reachable with any account's personal token: refusals in syslog only.
      for (const m of ['system.adminSession.create', 'system.roles.claim']) {
        assert.deepStrictEqual(f.isAudited(m), { syslog: true, platformTrail: true, platformTrailValidOnly: true }, m);
      }
      // An account erased with the admin key: done calls whose record names an administrator.
      assert.deepStrictEqual(f.isAudited('auth.delete'), { syslog: true, platformTrail: true, platformTrailValidOnly: true, platformTrailAdminOnly: true });
      for (const m of ['auth.register', 'oauth.consent.shown', 'oauth.token.exchange_refused', 'sso.refused', 'mfa.recover']) {
        assert.deepStrictEqual(f.isAudited(m), { syslog: true }, m);
      }
      assert.deepStrictEqual(f.isAudited('events.get'), { syslog: true, storage: true }, 'a call with an account: unchanged');
    });
    it('[AFPT2] opt in: a named id, or "all", is kept with its refusals; exclude and the storage filter still apply', () => {
      let f = make(buildFilter(['admin-acts', 'auth.register']));
      assert.strictEqual(f.isAudited('auth.register').platformTrail, true);
      assert.strictEqual(f.isAudited('sso.refused').platformTrail, undefined);
      assert.strictEqual(f.isAudited('system.setup.createSession').platformTrailValidOnly, true);
      f = make(buildFilter(['all']));
      assert.strictEqual(f.isAudited('sso.refused').platformTrail, true);
      assert.strictEqual(f.isAudited('system.setup.createSession').platformTrailValidOnly, undefined);
      f = make(buildFilter(['admin-acts', 'auth.delete']));
      assert.deepStrictEqual(f.isAudited('auth.delete'), { syslog: true, platformTrail: true }, 'named: every call, refusals and deletions by the holder too');
      f = make(buildFilter(['admin-acts'], ['system.roles.set']));
      assert.strictEqual(f.isAudited('system.roles.set').platformTrail, undefined);
      f = make(undefined, buildFilter(['all'], ['system.roles.delete']));
      assert.strictEqual(f.isAudited('system.roles.delete').platformTrail, undefined, 'the storage filter excludes it');
    });
    it('[AFPT3] "admin-acts" is a known name; a malformed platform trail filter is refused', () => {
      assert.deepStrictEqual(validation.unknownFilterMethods(buildFilter(['admin-acts'])), []);
      assert.throws(() => make({ methods: { include: [12], exclude: [] } }));
    });
    it('[AFPT4] "admin-acts" holds every administration id without a user: the per-area lists, the shell tool\'s acts, the admin-key writes under /reg, auth.delete', () => {
      const { ADMIN_ACT_METHODS } = require('audit/src/AuditFilter.ts');
      const areas = ['adminAudit', 'adminRoles', 'platformConfig', 'adminOauth'].map((a) => require('audit/src/apiMethods/' + a + '.ts'));
      for (const area of areas) {
        for (const m of area.withoutUser) assert.ok(ADMIN_ACT_METHODS.includes(m) || area.notAudited.includes(m), m);
      }
      for (const m of ['admin.cli.role.granted', 'admin.cli.role.deleted', 'admin.cli.claimCode.created', 'admin.cli.sessions.revoked', 'system.reg.servers.rename', 'system.reg.invitations.create', 'system.reg.records.set', 'system.reg.records.delete', 'system.reg.users.get', 'system.reg.servers.users.list', 'auth.delete']) {
        assert.ok(ADMIN_ACT_METHODS.includes(m), m);
      }
      for (const m of ['auth.register', 'mfa.recover', 'sso.refused']) assert.ok(!ADMIN_ACT_METHODS.includes(m), m);
    });
  });
  describe('[AF01] validation', () => {
    it('[3QJJ] must accept an existing method', () => {
      const method = 'events.get';
      assert.strictEqual(apiMethods.AUDITED_METHODS_MAP[method], true);
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.strictEqual(e, null); }
    });
    it('[YIDZ] must accept a valid method aggregator', () => {
      const method = 'events.all';
      const parts = method.split('.');
      assert.ok(apiMethods.AUDITED_METHODS.filter(m => m.startsWith(parts[0])).length > 0);
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.strictEqual(e, null); }
    });
    it('[74RS] must accept "all"', () => {
      const method = 'all';
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.strictEqual(e, null); }
    });
    it('[P6WW] must throw an error when providing a malformed filter', () => {
      try { validation.filter({ notMethods: { include: [], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
      try { validation.filter({ methods: { somethign: [], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
      try { validation.filter({ methods: { include: [12], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
    });
    it('[GFCE] must accept a method id that matches nothing (the boot warns about it)', () => {
      // An entry of another release must not stop a boot.
      validation.filter(buildFilter(['doesntexist'], []));
      validation.filter(buildFilter([], ['doesntexist']));
      validation.filter(buildFilter(['events.get', 'doesntexist'], ['doesnteither']));
      assert.deepStrictEqual(validation.unknownFilterMethods(buildFilter(['doesntexist'], ['doesnteither'])), ['doesntexist', 'doesnteither']);
    });
    it('[GY6E] must throw an error when providing an invalid aggregate method', () => {
      assert.throws(() => validation.filter(buildFilter(['something.all'])), /invalid aggregate method provided: "something\.all"/);
      assert.throws(() => validation.filter(buildFilter([], ['something.all'])), /invalid aggregate method provided: "something\.all"/);
      assert.throws(() => validation.filter(buildFilter(['events.get', 'doesntexist', 'something.all'])), /invalid aggregate method provided: "something\.all"/,
        'an aggregate after an unknown method is still checked');
    });
    it('[AFGW] must throw when an aggregate names a part of a group, not a whole group', () => {
      // "a" and "event" begin method ids ("accesses.get", "events.get") but name no group.
      for (const m of ['a.all', 'event.all', 'acc.all']) {
        const message = new RegExp('invalid aggregate method provided: "' + m.replace(/\./g, '\\.') + '"');
        assert.throws(() => validation.filter(buildFilter([m])), message, m);
        assert.throws(() => validation.filter(buildFilter([], [m])), message, m);
      }
      validation.filter(buildFilter(['accesses.all', 'account.all', 'events.all'], ['streams.all']));
    });
    it('[AFLU] must name the entries that match no method, once each', () => {
      const unknown = (include, exclude) => validation.unknownFilterMethods(buildFilter(include, exclude));
      assert.deepStrictEqual(unknown(['all'], []), []);
      assert.deepStrictEqual(unknown(['events.get', 'accesses.all', 'callBatch', 'oauth.token.revoked'], ['streams.all']), []);
      assert.deepStrictEqual(unknown(['event.get', 'events.getone'], ['event.get']), ['event.get', 'events.getone']);
      assert.deepStrictEqual(unknown(['a.all', 'something.all'], []), ['a.all', 'something.all'], 'a group is a whole name');
      for (const malformed of [undefined, null, {}, { methods: null }, { methods: { include: 'all', exclude: [12] } }]) {
        assert.deepStrictEqual(validation.unknownFilterMethods(malformed), [], JSON.stringify(malformed));
      }
    });
    it('[ASDWE] the server access writes are recorded with their user, and belong to the group "accesses.all"', () => {
      const { filter } = new AuditFilter({ syslogFilter: buildFilter([], ['all']), storageFilter: buildFilter(['accesses.all']) });
      for (const action of ['accesses.created', 'accesses.changed', 'accesses.deleted']) {
        assert.ok(apiMethods.WITH_USER_METHODS.includes(action), action);
        assert.deepStrictEqual(filter.methods[action], { storage: true }, action);
      }
    });
    it('[AACRA] the account creation is recorded with its user, and belongs to "account.all" and "all", not to a list without it', () => {
      assert.ok(apiMethods.ALL_METHODS.includes('account.created'));
      assert.ok(!apiMethods.WITHOUT_USER_METHODS.includes('account.created'));
      assert.ok(apiMethods.WITH_USER_METHODS.includes('account.created'));
      const storageOnly = (include, exclude = []) => new AuditFilter({ syslogFilter: buildFilter([], ['all']), storageFilter: buildFilter(include, exclude) }).filter.methods['account.created'];
      assert.deepStrictEqual(storageOnly(['account.all']), { storage: true });
      assert.deepStrictEqual(storageOnly(['all']), { storage: true });
      assert.strictEqual(storageOnly(['accesses.created', 'auth.login', 'account.update']), false, 'a one-by-one list without it');
      assert.deepStrictEqual(storageOnly(['accesses.created', 'account.created']), { storage: true });
      assert.strictEqual(storageOnly([], ['account.all']), false);
      // The register call itself is recorded without a user (the platform trail).
      assert.ok(apiMethods.WITHOUT_USER_METHODS.includes('auth.register'));
    });
    // Mutation caught: an id declared without a user (it would reach syslog only).
    it('[AADLA] the deletion and the restore of the account are recorded with their user, in "account.all" and "all", not in a list without them', () => {
      for (const action of ['account.deleted', 'account.restored']) {
        assert.ok(apiMethods.ALL_METHODS.includes(action), action);
        assert.ok(!apiMethods.WITHOUT_USER_METHODS.includes(action), action);
        assert.ok(apiMethods.WITH_USER_METHODS.includes(action), action);
        const storageOnly = (include, exclude = []) => new AuditFilter({ syslogFilter: buildFilter([], ['all']), storageFilter: buildFilter(include, exclude) }).filter.methods[action];
        assert.deepStrictEqual(storageOnly(['account.all']), { storage: true }, action);
        assert.deepStrictEqual(storageOnly(['all']), { storage: true }, action);
        assert.strictEqual(storageOnly(['accesses.created', 'auth.login', 'account.created']), false, action + ': a one-by-one list without it');
        assert.deepStrictEqual(storageOnly(['account.created', action]), { storage: true }, action);
      }
      // The deletion call itself is recorded without a user (the platform trail).
      assert.ok(apiMethods.WITHOUT_USER_METHODS.includes('auth.delete'));
    });
    it('[AFPT] a method without a user goes to the platform trail by the storage filter (the platform trail filter selecting all), a method with one never does', () => {
      const of = (include, exclude = []) => new AuditFilter({ syslogFilter: buildFilter([], ['all']), storageFilter: buildFilter(include, exclude), platformTrailFilter: buildFilter(['all']) });
      for (const m of apiMethods.AUDITED_METHODS) {
        const channels = of(['all']).isAudited(m);
        if (apiMethods.WITHOUT_USER_METHODS.includes(m)) {
          assert.deepStrictEqual(channels, { platformTrail: true }, m);
        } else {
          assert.deepStrictEqual(channels, { storage: true }, m);
        }
      }
      assert.deepStrictEqual(of(['system.all']).isAudited('system.createUser'), { platformTrail: true });
      assert.strictEqual(of(['events.all']).isAudited('system.createUser'), false);
      assert.strictEqual(of([], ['system.createUser']).isAudited('system.createUser'), false);
      assert.strictEqual(of(['all']).isAudited('system.listCores'), false, 'a read declared not audited');
      for (const m of ['system.getUserInfo', 'system.getAccess', 'system.listUsers', 'system.users.update', 'system.mailTemplates.set']) {
        assert.deepStrictEqual(of(['all']).isAudited(m), { platformTrail: true }, m);
      }
      for (const m of ['system.audit.get', 'system.certs.list', 'system.mailTemplates.list', 'system.mailTemplates.get']) {
        assert.strictEqual(of(['all']).isAudited(m), false, m + ' is a read not audited');
      }
    });
  });

  describe('[AF03] include and exclude together', () => {
    const channelsOf = (filter) => Object.fromEntries(apiMethods.ALL_METHODS.map((m) => [m, filter.isAudited(m)]));
    // The platform trail filter selecting every call without an account: the storage filter decides.
    const both = (f) => new AuditFilter({ syslogFilter: f, storageFilter: f, platformTrailFilter: buildFilter(['all']) });
    /** The methods a filter selects in syslog, and in either trail. */
    function selected (filter) {
      const channels = channelsOf(filter);
      return {
        syslog: apiMethods.ALL_METHODS.filter((m) => channels[m] && channels[m].syslog === true),
        stored: apiMethods.ALL_METHODS.filter((m) => channels[m] && (channels[m].storage === true || channels[m].platformTrail === true))
      };
    }

    // Mutation caught: "all" in `include` read as a method id, which selected
    // nothing as soon as `exclude` named anything (the whole audit lost).
    it('[AFIA] include "all" with exclusions selects every audited method but the excluded ones, in syslog and in storage', () => {
      const exclude = ['events.get', 'system.createUser', 'streams.all'];
      const expanded = ['events.get', 'system.createUser', ...apiMethods.ALL_METHODS.filter((m) => m.startsWith('streams.'))];
      const expected = apiMethods.AUDITED_METHODS.filter((m) => !expanded.includes(m));
      const { syslog, stored } = selected(both(buildFilter(['all'], exclude)));
      assert.deepStrictEqual(syslog, expected);
      assert.deepStrictEqual(stored, expected);
      assert.ok(expected.length > 50, 'most of the audit is kept');
      // the same as the exclude-only form
      assert.deepStrictEqual(selected(both(buildFilter([], exclude))), { syslog: expected, stored: expected });
    });

    it('[AFIE] an explicit include with exclusions selects the included ones less the excluded ones', () => {
      const { syslog, stored } = selected(both(buildFilter(['events.all', 'system.createUser', 'auth.login'], ['events.get', 'auth.login'])));
      const expected = apiMethods.AUDITED_METHODS.filter((m) => (m.startsWith('events.') && m !== 'events.get') || m === 'system.createUser');
      assert.deepStrictEqual(syslog, expected);
      assert.deepStrictEqual(stored, expected);
    });

    it('[AFID] defaults: everything audited with no filter given or `include: [all], exclude: []`; "all" on both sides selects nothing', () => {
      const { syslog, stored } = selected(both(buildFilter(['all'], [])));
      assert.deepStrictEqual(syslog, apiMethods.AUDITED_METHODS);
      assert.deepStrictEqual(stored, apiMethods.AUDITED_METHODS);
      // No filter given: every audited method in syslog; stored, all but the
      // public traffic without an account (the platform trail keeps the administration acts).
      const defaults = selected(new AuditFilter());
      assert.deepStrictEqual(defaults.syslog, apiMethods.AUDITED_METHODS);
      const { ADMIN_ACT_METHODS } = require('audit/src/AuditFilter.ts');
      const publicTraffic = apiMethods.WITHOUT_USER_METHODS.filter((m) => !ADMIN_ACT_METHODS.includes(m));
      assert.deepStrictEqual(defaults.stored, apiMethods.AUDITED_METHODS.filter((m) => !publicTraffic.includes(m)));
      assert.ok(publicTraffic.includes('auth.register') && !defaults.stored.includes('auth.register'));
      assert.deepStrictEqual(selected(both(buildFilter(['all'], ['all']))), { syslog: [], stored: [] });
      assert.deepStrictEqual(selected(both(buildFilter([], ['all']))), { syslog: [], stored: [] });
    });
  });

  describe('[AF02] initialization', () => {
    it('[H8RB] must expand aggregate methods', () => {
      const filter = new AuditFilter({ syslogFilter: buildFilter(), storageFilter: buildFilter(['events.all']) });
      apiMethods.AUDITED_METHODS.forEach(m => {
        const auditChannels = filter.isAudited(m);
        assert.strictEqual(auditChannels.syslog, true);
        if (m.startsWith('events.')) assert.strictEqual(auditChannels.storage, true);
      });
    });
  });
});
