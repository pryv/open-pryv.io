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
    it('[GFCE] must throw an error when providing an unexisting method', () => {
      try {
        validation.filter(buildFilter(['doesntexist']));
        assert.fail('must refuse an unexisting method');
      } catch (e) { assert.ok(e != null); }
    });
    it('[GY6E] must throw an error when providing an invalid aggregate method', () => {
      try {
        validation.filter(buildFilter(['something.all']));
        assert.fail('must throw an error');
      } catch (e) { assert.ok(e != null); }
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
