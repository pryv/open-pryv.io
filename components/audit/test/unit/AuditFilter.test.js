/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
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
      // The register call itself stays syslog-only.
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
      // The deletion call itself stays syslog-only.
      assert.ok(apiMethods.WITHOUT_USER_METHODS.includes('auth.delete'));
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
