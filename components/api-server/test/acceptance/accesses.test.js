/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, charlatan, _ */

const { promisify } = require('util');
const lodash = require('lodash');
const timestamp = require('unix-timestamp');
const { ErrorIds } = require('errors/src');
const helpers = require('../helpers');

describe('[AC01] accesses', () => {
  let storage;

  before(async () => {
    await initTests();
    await initCore();
    storage = helpers.dependencies.storage.user.accesses;
  });
  before(async () => {
  });

  describe('[AC02] access deletions', () => {
    let userId, streamId, activeToken, deletedToken, accessToken;
    before(async () => {
      userId = cuid();
      streamId = cuid();
      activeToken = cuid();
      deletedToken = cuid();
      accessToken = cuid();
    });

    let mongoFixtures;
    before(async () => {
      mongoFixtures = getNewFixture();
    });
    after(async () => {
      await mongoFixtures.context.cleanEverything();
    });

    describe('[AC03] when given a few existing accesses', () => {
      const deletedTimestamp = timestamp.now('-1h');
      before(async () => {
        const user = await mongoFixtures.user(userId);
        await user.stream({ id: streamId }, () => { });
        await user.access({
          type: 'app',
          token: activeToken,
          name: 'active access',
          permissions: []
        });
        await user.access({
          type: 'app',
          token: deletedToken,
          name: 'deleted access',
          permissions: [],
          deleted: deletedTimestamp
        });
        await user.access({ token: accessToken, type: 'personal' });
        await user.session(accessToken);
      });

      describe('[AC04] accesses.get', () => {
        let res, accesses, deletions;
        before(async () => {
          res = await coreRequest
            .get(`/${userId}/accesses?includeDeletions=true`)
            .set('Authorization', accessToken);
          accesses = res.body.accesses;
          deletions = res.body.accessDeletions;
        });
        it('[H7ZS] access should contain tokens and apiEndpoints', () => {
          for (const access of accesses) {
            assert.ok(access.token);
            assert.ok(access.apiEndpoint);
            assert.ok(access.apiEndpoint.includes(access.token));
          }
        });
        it('[P12L] should contain deletions', () => {
          assert.ok(deletions);
        });
        it('[BQ7M] contains active accesses', () => {
          assert.strictEqual(accesses.length, 2);
          const activeAccess = accesses.find((a) => a.token === activeToken);
          assert.ok(activeAccess);
        });
        it('[NVCQ] contains deleted accesses as well', () => {
          assert.strictEqual(deletions.length, 1);
          assert.strictEqual(deletions[0].token, deletedToken);
        });
        it('[6ZQL] deleted access are in UTC (seconds) format', () => {
          const deletedAccess = deletions[0];
          assert.strictEqual(deletedAccess.deleted, deletedTimestamp);
        });
      });
      describe('[AC05] accesses.create', () => {
        describe('[AC06] for a valid access', () => {
          let createdAccess;
          const access = {
            name: 'whatever',
            type: 'app',
            permissions: [
              {
                streamId: 'stream',
                level: 'read'
              }
            ]
          };
          before(async () => {
            const res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(access);
            createdAccess = res.body.access;
          });
          it('[N3Q1] should contain an access', () => {
            assert.ok(createdAccess);
          });
          it('[8UOW] access should contain token and apiEndpoint', () => {
            assert.ok(createdAccess.token);
            assert.ok(createdAccess.apiEndpoint, 'Missing API endpoint');
            assert.ok(createdAccess.apiEndpoint.includes(createdAccess.token));
          });
          it('[J77Z] should contain the set values, but no "deleted" field in the API response', () => {
            assert.deepEqual(access, _.pick(createdAccess, ['name', 'permissions', 'type']));
            assert.ok(createdAccess.deleted == null);
          });
          it('[A4JP] should contain the field "deleted:null" in the database', async () => {
            const findAllAsync = promisify((query, opts, cb) => storage.findAll(query, opts, cb));
            const accesses = await findAllAsync({ id: userId }, {});
            const deletedAccess = accesses.find((a) => a.name === access.name);
            assert.ok(deletedAccess.deleted == null, 'deleted field should be null or undefined');
          });
        });
        describe('[AC07] for a deleted access', () => {
          let res, error;
          const deletedAccess = {
            name: 'whatever',
            type: 'app',
            permissions: [
              {
                streamId: 'stream',
                level: 'read'
              }
            ],
            deleted: timestamp.now()
          };
          before(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(deletedAccess);
          });
          it('[1DJ6] should return an error', () => {
            error = res.body.error;
            assert.ok(error);
          });
          it('[7ZPK] error should say that the deleted field is forbidden upon creation', () => {
            assert.strictEqual(error.id, ErrorIds.InvalidParametersFormat);
          });
        });
      });
      describe('[AC08] accesses.update', () => {
        let res, error, activeAccess;
        before(async () => {
          res = await coreRequest
            .get(`/${userId}/accesses`)
            .set('Authorization', accessToken);
          activeAccess = res.body.accesses.find((a) => a.token === activeToken);
          res = await coreRequest
            .put(`/${userId}/accesses/${activeAccess.id}`)
            .set('Authorization', accessToken)
            .send({
              update: { deleted: timestamp.now() }
            });
          error = res.body.error;
        });
        it('[JNJK] should return an error', () => {
          assert.ok(error);
        });
        it('[OS36] error should say that the deleted field is forbidden upon update', () => {
          assert.strictEqual(error.id, ErrorIds.Gone);
        });
      });
    });
  });

  describe('[AC09] Delete app access', () => {
    let username, streamId, access, sharedAccess1, sharedAccess2, sharedAccess3, expiredSharedAccess;
    before(() => {
      username = cuid();
      streamId = charlatan.Lorem.word();
    });
    let mongoFixtures;
    before(async () => {
      mongoFixtures = getNewFixture();
      const user = await mongoFixtures.user(username);
      await user.stream({ id: streamId }, () => { });
      access = await user.access({
        type: 'app',
        name: charlatan.Lorem.word() + 0,
        permissions: [
          {
            streamId,
            level: 'read'
          }
        ]
      });
      access = access.attrs;
      sharedAccess1 = await user.access({
        type: 'shared',
        name: charlatan.Lorem.word() + 1,
        permissions: [
          {
            streamId,
            level: 'read'
          }
        ],
        createdBy: access.id
      });
      sharedAccess1 = sharedAccess1.attrs;
      sharedAccess2 = await user.access({
        type: 'shared',
        name: charlatan.Lorem.word() + 2,
        permissions: [
          {
            streamId,
            level: 'read'
          }
        ],
        createdBy: access.id
      });
      sharedAccess2 = sharedAccess2.attrs;
      // some unrelated access that shouldn't be changed
      sharedAccess3 = await user.access({
        type: 'shared',
        name: charlatan.Lorem.word() + 3,
        permissions: [
          {
            streamId,
            level: 'read'
          }
        ]
      });
      sharedAccess3 = sharedAccess3.attrs;
      expiredSharedAccess = await user.access({
        type: 'shared',
        expires: timestamp.now('-1d'),
        name: charlatan.Lorem.word() + 4,
        permissions: [
          {
            streamId,
            level: 'read'
          }
        ]
      });
      expiredSharedAccess = expiredSharedAccess.attrs;
    });
    after(async () => {
      await mongoFixtures.clean();
    });

    describe('[AC10] when deleting an app access that created shared accesses', () => {
      let res;
      before(async () => {
        res = await coreRequest
          .del(`/${username}/accesses/${access.id}`)
          .set('Authorization', access.token);
      });
      it('[WE2O] should return the accessDeletion and relatedDeletions', () => {
        const accessDeletion = res.body.accessDeletion;
        const relatedDeletions = res.body.relatedDeletions;
        assert.ok(accessDeletion);
        assert.ok(relatedDeletions);
        assert.strictEqual(accessDeletion.id, access.id);
        let found1 = false;
        let found2 = false;
        let found3 = false;
        assert.strictEqual(relatedDeletions.length, 2);
        relatedDeletions.forEach((a) => {
          if (a.id === sharedAccess1.id) { found1 = true; }
          if (a.id === sharedAccess2.id) { found2 = true; }
          if (a.id === expiredSharedAccess.id) { found3 = true; }
        });
        assert.strictEqual(found1, true);
        assert.strictEqual(found2, true);
        assert.strictEqual(found3, false);
      });
      it('[IVWP] should delete it and the accesses it created, not touching the expired ones', async () => {
        const findAllAsync = promisify((query, opts, cb) => storage.findAll(query, opts, cb));
        const accesses = await findAllAsync({ id: username }, {});
        const deletedAccess = accesses.find((a) => a.id === access.id);
        const deletedShared1 = accesses.find((a) => a.id === sharedAccess1.id);
        const deletedShared2 = accesses.find((a) => a.id === sharedAccess2.id);
        const notDeletedAccess3 = accesses.find((a) => a.id === sharedAccess3.id);
        const notDeletedAccess4 = accesses.find((a) => a.id === expiredSharedAccess.id);
        assert.ok(deletedAccess.deleted);
        assert.ok(deletedShared1.deleted);
        assert.ok(deletedShared2.deleted);
        assert.ok(notDeletedAccess3.deleted == null);
        assert.ok(notDeletedAccess4.deleted == null);
      });
    });
  });

  describe('[AC11] access expiry', () => {
    // Uses dynamic fixtures:
    // Set up a few ids that we'll use for testing. NOTE that these ids will
    // change on every test run.
    let userId, streamId, accessToken, expiredToken, validId;
    let hasExpiryId, hasExpiryToken;
    before(async () => {
      userId = cuid();
      streamId = cuid();
      accessToken = cuid();
      expiredToken = cuid();
      validId = cuid();
      hasExpiryId = cuid();
      hasExpiryToken = cuid();
    });
    describe('[AC12] when given a few existing accesses', () => {
      let mongoFixtures;
      before(async () => {
        mongoFixtures = getNewFixture();
        const user = await mongoFixtures.user(userId);
        await user.stream({ id: streamId }, () => { });
        // A token that expired one day ago
        await user.access({
          type: 'app',
          token: expiredToken,
          expires: timestamp.now('-1d'),
          name: 'expired access',
          permissions: []
        });
        // A token that is still valid
        await user.access({
          id: hasExpiryId,
          type: 'app',
          token: hasExpiryToken,
          expires: timestamp.now('1d'),
          name: 'valid access',
          permissions: [
            {
              streamId: 'diary',
              defaultName: 'Diary',
              level: 'read'
            }
          ]
        });
        // A token that did never expire
        await user.access({
          id: validId,
          type: 'app',
          token: cuid(),
          name: 'doesnt expire'
        });
        await user.access({ token: accessToken, type: 'personal' });
        await user.session(accessToken);
      });

      const isExpired = (e) => e.expires != null && timestamp.now() > e.expires;
      describe('[AC13] accesses.get', () => {
        describe('[AC14] vanilla version', () => {
          let res;
          let accesses;
          beforeEach(async () => {
            res = await coreRequest
              .get(`/${userId}/accesses`)
              .set('Authorization', accessToken);
            accesses = res.body.accesses;
          });
          it('[489J] succeeds', () => {
            assert.ok(accesses);
          });
          it('[7NPE] contains only active accesses', () => {
            for (const a of accesses) {
              assert.strictEqual(isExpired(a), false, `Access '${a.name}' is expired`);
            }
          });
        });
        describe('[AC15] when given the includeExpired=true parameter', () => {
          let res;
          let accesses;
          beforeEach(async () => {
            res = await coreRequest
              .get(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .query('includeExpired=true');
            accesses = res.body.accesses;
          });
          it('[PIGE] succeeds', () => {
            assert.ok(accesses);
          });
          it('[DZHL] includes expired accesses', () => {
            assert.ok(lodash.filter(accesses, isExpired).length > 0);
          });
        });
      });
      describe('[AC16] accesses.create', () => {
        describe('[AC17] when called with expireAfter>0', () => {
          const attrs = {
            name: 'For colleagues (1)',
            type: 'app',
            expireAfter: 3600,
            permissions: [
              {
                streamId: 'work',
                level: 'read'
              }
            ]
          };
          let res, access;
          beforeEach(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(attrs);
            access = res.body.access;
            if (!res.ok && res.body.error != null) {
              console.error(res.body.error);
              // console.dir(res.body.error.data[0].inner);
            }
          });
          it('[3ONA] creates an access with set expiry timestamp', () => {
            assert.strictEqual(res.status, 201);
            assert.ok(access.expires > timestamp.now());
          });
        });
        describe('[AC18] when called with expireAfter=0', () => {
          const attrs = {
            name: 'For colleagues (2)',
            expireAfter: 0,
            type: 'app',
            permissions: [
              {
                streamId: 'work',
                level: 'read'
              }
            ]
          };
          let res, access;
          beforeEach(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(attrs);
            access = res.body.access;
            if (!res.ok && res.body.error != null) {
              console.error(res.body.error);
              // console.dir(res.body.error.data[0].inner);
            }
          });
          it('[8B65] creates an expired access', () => {
            assert.strictEqual(res.status, 201);
            assert.ok(timestamp.now() > access.expires);
          });
        });
        describe('[AC19] when called with expireAfter<0', () => {
          const attrs = {
            name: 'For colleagues (3)',
            expireAfter: -100,
            type: 'app',
            permissions: [
              {
                streamId: 'work',
                level: 'read'
              }
            ]
          };
          let res;
          beforeEach(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(attrs);
          });
          it('[JHWH] fails', () => {
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.message, 'expireAfter cannot be negative.');
          });
        });
        describe('[AC20] Store accesses', () => {
          it('[JZWH] create an access on :dummy: store', async () => {
            const attrs = {
              name: 'Dummy Access',
              type: 'app',
              permissions: [
                {
                  streamId: ':dummy:',
                  defaultName: 'Blip',
                  level: 'read'
                }
              ]
            };

            const res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(attrs);
            assert.strictEqual(res.status, 201);
          });

          it('[JUWH] create an access :dummy:marcella on :dummy: store', async () => {
            const attrs = {
              name: 'Dummy Access',
              type: 'app',
              permissions: [
                {
                  streamId: ':dummy:marcella',
                  defaultName: 'Marcella',
                  level: 'read'
                }
              ]
            };

            const res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(attrs);
            assert.strictEqual(res.status, 501);
            assert.ok(res.body.error);
            assert.strictEqual(res.body.error.id, 'api-unavailable');
            assert.strictEqual(res.body.error.message, 'streams.create');
          });
        });
      });
      describe('[AC21] accesses.checkApp', () => {
        describe('[AC22] when the matching access is not expired', () => {
          let res;
          beforeEach(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses/check-app`)
              .set('Authorization', accessToken)
              .send({
                requestingAppId: 'valid access',
                requestedPermissions: [
                  {
                    streamId: 'diary',
                    defaultName: 'Diary',
                    level: 'read'
                  }
                ]
              });
          });
          it('[B66B] returns the matching access', () => {
            assert.strictEqual(res.ok, true);
            assert.strictEqual(res.body.matchingAccess.token, hasExpiryToken);
          });
        });
        describe('[AC23] when the matching access is expired', () => {
          let res;
          beforeEach(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses/check-app`)
              .set('Authorization', accessToken)
              .send({
                requestingAppId: 'expired access',
                requestedPermissions: []
              });
            // NOTE It is important that the reason why we have a mismatch here is
            // that the access is expired, not that we're asking for different
            // permissions.
          });
          it('[DLHJ] returns no match', () => {
            assert.strictEqual(res.body.matchingAccess, undefined);
            const mismatching = res.body.mismatchingAccess;
            assert.strictEqual(mismatching.token, expiredToken);
          });
        });
      });
      describe('[AC24] other API accesses', () => {
        function apiAccess (token) {
          return coreRequest
            .get(`/${userId}/events`)
            .set('Authorization', token);
        }
        describe('[AC25] using an expired access', () => {
          let res;
          beforeEach(async () => {
            res = await apiAccess(expiredToken);
          });
          it('[AJG5] fails', () => {
            assert.strictEqual(res.status, 403);
          });
          it('[KGT4] returns a proper error message', () => {
            const error = res.body.error;
            assert.ok(error);
            assert.strictEqual(error.id, 'forbidden');
            assert.strictEqual(error.message, 'Access has expired.');
          });
        });
        describe('[AC26] using a valid access', () => {
          let res;
          beforeEach(async () => {
            res = await apiAccess(accessToken);
          });
          it('[CBRF] succeeds', () => {
            assert.strictEqual(res.status, 200);
          });
        });
      });
    });
  });

  describe('[AC27] access client data', () => {
    function sampleAccess (name, clientData) {
      return {
        id: cuid(),
        type: 'app',
        name,
        permissions: [],
        clientData
      };
    }
    // Set up a few ids that we'll use for testing. NOTE that these ids will
    // change on every test run.
    let userId, streamId, accessToken, complexClientData, existingAccess;
    let toBeUpdateAccess1, toBeUpdateAccess2, toBeUpdateAccess3, emptyClientDataAccess;
    let fixtureAccesses;
    before(async () => {
      userId = cuid();
      streamId = cuid();
      accessToken = cuid();
      complexClientData = {
        aString: 'a random string',
        aNumber: 42,
        anArray: ['what', 'a', 'big', 'array', 'you', 'got'],
        anObject: { child: 'I feel empty', leaf: 42 }
      };
      existingAccess = sampleAccess('Access with complex clientData', complexClientData);
      toBeUpdateAccess1 = sampleAccess('Access to be updated 1', complexClientData);
      toBeUpdateAccess2 = sampleAccess('Access to be updated 2', complexClientData);
      toBeUpdateAccess3 = sampleAccess('Access to be updated 3', complexClientData);
      emptyClientDataAccess = sampleAccess('Access with empty clientData', null);
      fixtureAccesses = [
        existingAccess,
        toBeUpdateAccess1,
        toBeUpdateAccess2,
        toBeUpdateAccess3,
        emptyClientDataAccess
      ];
    });
    describe('[AC28] when given a few existing accesses', () => {
      let mongoFixtures;
      before(async () => {
        mongoFixtures = getNewFixture();
        const user = await mongoFixtures.user(userId);
        await user.stream({ id: streamId }, () => { });
        await user.access({ token: accessToken, type: 'personal' });
        await user.access(existingAccess);
        await user.access(toBeUpdateAccess1);
        await user.access(toBeUpdateAccess2);
        await user.access(toBeUpdateAccess3);
        await user.access(emptyClientDataAccess);
        await user.session(accessToken);
      });

      describe('[AC29] accesses.get', () => {
        let res, accesses;
        before(async () => {
          res = await coreRequest
            .get(`/${userId}/accesses`)
            .set('Authorization', accessToken);
          accesses = res.body.accesses;
        });
        it('[KML2] succeeds', () => {
          assert.ok(accesses);
        });
        it('[NY85] contains existing accesses with clientData', () => {
          for (const a of accesses) {
            const fixtureAccess = fixtureAccesses.find((f) => {
              return f.id === a.id;
            });
            if (fixtureAccess != null) {
              assert.deepEqual(a.clientData, fixtureAccess.clientData);
            }
          }
        });
      });
      describe('[AC30] accesses.create', () => {
        function sampleAccess (name, clientData) {
          return {
            name,
            type: 'app',
            permissions: [
              {
                streamId: 'work',
                level: 'read'
              }
            ],
            clientData
          };
        }
        function checkResultingAccess (res) {
          const access = res.body.access;
          assert.strictEqual(res.ok, true);
          assert.ok(res.body.error == null);
          assert.ok(access);
          return access;
        }
        describe('[AC31] when called with clientData={}', () => {
          let res, access;
          before(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(sampleAccess('With empty clientData', {}));
            access = checkResultingAccess(res);
          });
          it('[OMUO] creates an access with empty clientData', () => {
            assert.strictEqual(res.status, 201);
            assert.deepEqual(access.clientData, {});
          });
        });
        describe('[AC32] when called with clientData=null', () => {
          let res;
          before(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(sampleAccess('With null clientData', null));
          });
          it('[E5C1] throws a schema error', () => {
            assert.strictEqual(res.ok, false);
            assert.ok(res.body.error);
          });
        });
        describe('[AC33] when called with complex clientData', () => {
          let res, access;
          before(async () => {
            res = await coreRequest
              .post(`/${userId}/accesses`)
              .set('Authorization', accessToken)
              .send(sampleAccess('With complex clientData', complexClientData));
            access = checkResultingAccess(res);
          });
          it('[JYD4] creates an access with complex clientData', () => {
            assert.strictEqual(res.status, 201);
            assert.deepEqual(access.clientData, complexClientData);
          });
        });
      });
      describe('[AC34] accesses.checkApp', () => {
        async function checkAppRequest (req) {
          const res = await coreRequest
            .post(`/${userId}/accesses/check-app`)
            .set('Authorization', accessToken)
            .send(req);
          assert.strictEqual(res.ok, true);
          assert.ok(res.body);
          assert.ok(res.body.error == null);
          return res.body;
        }
        describe('[AC35] when the provided clientData matches the existing clientData', () => {
          let body;
          before(async () => {
            body = await checkAppRequest({
              requestingAppId: existingAccess.name,
              requestedPermissions: existingAccess.permissions,
              clientData: existingAccess.clientData
            });
          });
          it('[U1AM] returns the matching access', () => {
            assert.ok(body.matchingAccess);
            assert.strictEqual(body.matchingAccess.id, existingAccess.id);
          });
        });
        describe('[AC36] when the provided clientData does not match the existing clientData', () => {
          let body;
          before(async () => {
            body = await checkAppRequest({
              requestingAppId: existingAccess.name,
              requestedPermissions: existingAccess.permissions,
              clientData: {}
            });
          });
          it('[2EER] returns no match', () => {
            assert.ok(body.mismatchingAccess);
            assert.strictEqual(body.mismatchingAccess.id, existingAccess.id);
          });
        });
        describe('[AC37] when no clientData is provided but existing access has one', () => {
          let body;
          before(async () => {
            body = await checkAppRequest({
              requestingAppId: existingAccess.name,
              requestedPermissions: existingAccess.permissions
            });
          });
          it('[DHZQ] returns no match', () => {
            assert.ok(body.mismatchingAccess);
            assert.strictEqual(body.mismatchingAccess.id, existingAccess.id);
          });
        });
      });
    });
  });

  describe('[AC38] access-info', () => {
    let mongoFixtures;
    const userId = cuid();
    let user;
    const appToken = cuid();

    before(async () => {
      mongoFixtures = getNewFixture();
      user = await mongoFixtures.user(userId);
      await user.access({
        type: 'app',
        token: appToken,
        name: charlatan.Lorem.word(),
        permissions: [
          {
            streamId: charlatan.Lorem.word(),
            level: 'read'
          }
        ]
      });
    });

    function path () {
      return `/${userId}/access-info`;
    }
    it('[PH0K] should return the username', async () => {
      const res = await coreRequest
        .get(path())
        .set('Authorization', appToken);
      const body = res.body;
      assert.ok(body.user);
      assert.ok(body.user.username);
      assert.strictEqual(body.user.username, userId);
    });

    // NOTE: This test requires server restart with custom settings - skipped in Pattern C
    describe.skip('[APRA] When password rules are enabled', async () => {
      // This test requires spawning server with different settings (settingsOverride)
      // which is not supported in Pattern C. Keep using Pattern B if this test is needed.
    });
  });
});
