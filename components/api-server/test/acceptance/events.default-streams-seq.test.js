/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');
const path = require('path');
const assert = require('node:assert');
const supertest = require('supertest');
const charlatan = require('charlatan');

const ErrorIds = require('errors').ErrorIds;
const { ErrorMessages } = require('errors/src/ErrorMessages');
const { getApplication } = require('api-server/src/application');

const { pubsub } = require('messages');
const accountStreams = require('business/src/system-streams');
const { addPrivatePrefixToStreamId, addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');
const { databaseFixture } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');

const { getMall } = require('mall');

describe('[FG5R] Events of system streams', () => {
  let validation;
  let app;
  let request;
  let res;
  let mongoFixtures;
  let basePath;
  let access;
  let user;
  let mall;
  let eventData;
  let savedIntegrityCheck;

  async function getOneEvent (userId, streamId) {
    const events = await mall.events.get(userId, { streams: [{ any: [streamId] }] });
    if (events != null && events.length > 0) return events[0];
    return null;
  }

  async function createUser () {
    // Use cuid for unique username to avoid parallel test conflicts
    user = await mongoFixtures.user('evtdef_' + cuid.slug(), {
      insurancenumber: charlatan.Number.number(4),
      phoneNumber: charlatan.Lorem.characters(3)
    });
    basePath = '/' + user.attrs.username + '/events';
    access = await user.access({
      type: 'personal',
      token: cuid()
    });
    access = access.attrs;
    await user.session(access.token);
    return user;
  }

  before(async function () {
    savedIntegrityCheck = process.env.DISABLE_INTEGRITY_CHECK;
    process.env.DISABLE_INTEGRITY_CHECK = '1';
    const helpers = require('api-server/test/helpers');
    validation = helpers.validation;
    mongoFixtures = databaseFixture(await produceStorageConnection());

    app = getApplication(true);
    await app.initiate();

    // Initialize notifications dependency

    const testMsgs = [];
    const testNotifier = {
      emit: (...args) => testMsgs.push(args)
    };
    pubsub.setTestNotifier(testNotifier);

    pubsub.status.emit(pubsub.SERVER_READY);
    await require('api-server/src/methods/events')(app.api);

    request = supertest(app.expressApp);

    mall = await getMall();
  });

  after(async function () {
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();
    await usersRepository.deleteAll();
    if (savedIntegrityCheck != null) {
      process.env.DISABLE_INTEGRITY_CHECK = savedIntegrityCheck;
    } else {
      delete process.env.DISABLE_INTEGRITY_CHECK;
    }
  });

  describe('[ED01] GET /events', () => {
    describe('[ED02] When using a personal access', () => {
      before(async function () {
        await createUser();
        res = await request.get(basePath).set('authorization', access.token);
      });
      it('[KS6K] should return visible system events only', () => {
        const separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
        const readableMap = Object.fromEntries(Object.entries(accountStreams.accountMap).filter(([, s]) => s.isShown));
        delete readableMap[':_system:storageUsed'];
        const accountStreamIds = Object.keys(readableMap);
        assert.strictEqual(separatedEvents.accountStreamsEvents.length, accountStreamIds.length);
        accountStreamIds.forEach(accountStreamId => {
          let found = false;
          separatedEvents.accountStreamsEvents.forEach(event => {
            if (event.streamIds.includes(accountStreamId)) found = true;
          });
          assert.strictEqual(found, true);
        });
      });
    });
    describe('[ED03] When using a shared access with a read-level permission on the .account stream', () => {
      let separatedEvents;
      before(async function () {
        await createUser();
        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: addPrivatePrefixToStreamId('account'),
            level: 'read'
          }]
        });
        res = await request.get(basePath).set('authorization', sharedAccess.attrs.token);
        // lets separate core events from all other events and validate them separatelly
        separatedEvents = validation.separateAccountStreamsAndOtherEvents(res.body.events);
      });

      it('[DRFH] should return visible system events only', () => {
        const readableMap = Object.fromEntries(Object.entries(accountStreams.accountMap).filter(([, s]) => s.isShown));
        delete readableMap[':_system:storageUsed'];
        const accountStreamIds = Object.keys(readableMap);
        assert.strictEqual(separatedEvents.accountStreamsEvents.length, accountStreamIds.length);
        accountStreamIds.forEach(accountStreamId => {
          let found = false;
          separatedEvents.accountStreamsEvents.forEach(event => {
            if (event.streamIds.includes(accountStreamId)) found = true;
          });
          assert.strictEqual(found, true);
        });
      });
    });

    describe('[ED04] When using a shared access with a read-level permission on all streams (star) and a visible system stream', () => {
      let sharedAccess;
      let systemStreamId;
      before(async function () {
        systemStreamId = addCustomerPrefixToStreamId('email');
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          },
          {
            streamId: systemStreamId,
            level: 'read'
          }]
        });
      });

      it('[GF3A] should return only the account event for which a permission was explicitely provided', async () => {
        res = await request.get(basePath).query({ streams: [addCustomerPrefixToStreamId('email')] }).set('authorization', sharedAccess.attrs.token);
        assert.strictEqual(res.body.events.length, 1);
        assert.strictEqual(res.body.events[0].streamIds.includes(systemStreamId), true);
      });
    });

    describe('[ED05] When using a shared access with a read-level permission on all streams (star)', () => {
      let sharedAccess;
      before(async function () {
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          }]
        });
        res = await request.get(basePath).set('authorization', sharedAccess.attrs.token);
      });

      it('[RM74] should not return any system events', () => {
        assert.strictEqual(res.body.events.length, 0);
      });
    });
  });

  describe('[ED06] GET /events/<id>', () => {
    async function findDefaultCoreEvent (streamId) {
      return await getOneEvent(user.attrs.id, streamId);
    }
    describe('[ED10] When using a personal access', () => {
      describe('[ED11] to retrieve a visible system event', () => {
        let defaultEvent;
        const streamId = 'language';
        let systemStreamId;
        before(async function () {
          systemStreamId = addPrivatePrefixToStreamId(streamId);
          await createUser();
          defaultEvent = await findDefaultCoreEvent(systemStreamId);
          res = await request.get(path.join(basePath, defaultEvent.id)).set('authorization', access.token);
        });
        it('[9IEX] should return 200', () => {
          assert.strictEqual(res.status, 200);
        });
        it('[IYE6] should return the event', () => {
          assert.strictEqual(res.body.event.id, defaultEvent.id);
          assert.strictEqual(res.body.event.streamIds[0], systemStreamId);
        });
      });
      describe('[ED12] to retrieve a non visible system event', () => {
        before(async function () {
          await createUser();
          const defaultEvent = await findDefaultCoreEvent(addPrivatePrefixToStreamId('invitationToken'));
          res = await request.get(path.join(basePath, defaultEvent.id)).set('authorization', access.token);
        });
        it('[Y2OA] should return 403', () => {
          assert.strictEqual(res.status, 403);
        });

        it('[DHZE] should return the right error message', () => {
          assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
        });
      });
    });

    describe('[ED13] When using a shared access with a read-level permission on all streams (star) and a visible system stream', () => {
      let defaultEvent;
      let systemStreamId;
      before(async () => {
        systemStreamId = addPrivatePrefixToStreamId('language');
        await createUser();
        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'read'
          },
          {
            streamId: systemStreamId,
            level: 'read'
          }]
        });

        defaultEvent = await findDefaultCoreEvent(systemStreamId);
        res = await request.get(path.join(basePath, defaultEvent.id))
          .set('authorization', sharedAccess.attrs.token);
      });
      it('[YPZX] should return 200', () => {
        assert.strictEqual(res.status, 200);
      });
      it('[1NRM] should return the event', () => {
        assert.ok(res.body.event);
        assert.strictEqual(res.body.event.streamIds.includes(systemStreamId), true);
      });
    });
  });

  describe('[ED07] POST /events', () => {
    let eventData;
    describe('[ED14] When using a personal access', () => {
      describe('[ED15] to create an editable system event', () => {
        describe('[ED16] which is non indexed and non unique', () => {
          before(async function () {
            await createUser();
            eventData = {
              streamIds: [addCustomerPrefixToStreamId('phoneNumber')],
              content: charlatan.Lorem.characters(7),
              type: 'string/pryv'
            };

            res = await request.post(basePath)
              .send(eventData)
              .set('authorization', access.token);
          });
          it('[F308] should return 201', () => {
            assert.strictEqual(res.status, 201);
          });
          it('[9C2D] should return the created event', () => {
            assert.strictEqual(res.body.event.content, eventData.content);
            assert.strictEqual(res.body.event.type, eventData.type);
            assert.deepStrictEqual(res.body.event.streamIds, [addCustomerPrefixToStreamId('phoneNumber')]);
          });
          it('[A9DC] should update the field value (single event per field)', async () => {
            const allEvents = await mall.events.get(user.attrs.id,
              { streams: [{ any: [addCustomerPrefixToStreamId('phoneNumber')] }] });

            assert.strictEqual(allEvents.length, 1);
            assert.strictEqual(allEvents[0].content, eventData.content);
            assert.deepStrictEqual(allEvents[0].streamIds, [addCustomerPrefixToStreamId('phoneNumber')]);
          });
        });
        describe('[ED17] which is indexed', function () {
          describe('[ED18] when the new value is valid', () => {
            before(async function () {
              await createUser();
              eventData = {
                streamIds: [addPrivatePrefixToStreamId('language')],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              };

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[8C80] should return 201', () => {
              assert.strictEqual(res.status, 201);
            });
            it('[67F7] should return the created event', () => {
              assert.strictEqual(res.body.event.content, eventData.content);
              // Account store enforces the configured type for the stream
              assert.strictEqual(res.body.event.type, 'language/iso-639-1');
              assert.deepStrictEqual(res.body.event.streamIds, [addPrivatePrefixToStreamId('language')]);
            });
            it('[467D] should update the field value (single event per field)', async () => {
              const allEvents = await mall.events.get(user.attrs.id,
                { streams: [{ any: [addPrivatePrefixToStreamId('language')] }] });

              assert.strictEqual(allEvents.length, 1);
              assert.strictEqual(allEvents[0].content, eventData.content);
              assert.deepStrictEqual(allEvents[0].streamIds, [addPrivatePrefixToStreamId('language')]);
            });
          });

          describe('[ED19] when the new value is invalid', () => {
            before(async function () {
              await createUser();
              eventData = {
                streamIds: [addPrivatePrefixToStreamId('language')],
                content: [charlatan.Lorem.characters(7)],
                type: 'string/pryv'
              };

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[PQHR] should return 400', () => {
              assert.strictEqual(res.status, 400);
            });
          });
        });
        describe('[ED20] which is indexed and unique', () => {
          describe('[WCIU] whose content is unique', () => {
            let allEventsInDb;
            let streamId;
            before(async function () {
              streamId = addCustomerPrefixToStreamId('email');
              await createUser();
              eventData = {
                streamIds: [streamId],
                content: charlatan.Lorem.characters(7),
                type: 'string/pryv'
              };

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
              allEventsInDb = await mall.events.get(user.attrs.id, { streams: [{ any: [streamId] }], state: 'all' });
            });
            it('[SQZ2] should return 201', () => {
              assert.strictEqual(res.status, 201);
            });
            it('[YS79] should return the created event', () => {
              assert.strictEqual(res.body.event.content, eventData.content);
              // Account store enforces the configured type for the stream
              assert.strictEqual(res.body.event.type, 'email/string');
            });
            it('[DA23] should update the field value (single event per field)', async () => {
              assert.strictEqual(allEventsInDb.length, 1);
              assert.deepStrictEqual(allEventsInDb[0].streamIds, [streamId]);
              assert.strictEqual(allEventsInDb[0].content, eventData.content);
            });
          });
          describe('[ED21] whose content is already taken by another user', () => {
            before(async function () {
              // Create user1 with a specific email
              const user1 = await createUser();
              const user1Email = user1.attrs.email;

              // Create user2 and try to use user1's email
              await createUser();
              eventData = {
                streamIds: [addCustomerPrefixToStreamId('email')],
                content: user1Email,
                type: 'string/pryv'
              };

              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[89BC] should return 409', () => {
              assert.strictEqual(res.status, 409);
            });
            it('[10BC] should return the correct error', () => {
              assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
              assert.deepStrictEqual(res.body.error.data, { email: eventData.content });
            });
          });
          describe('[6B8D] When creating an event with an email already taken by another user', () => {
            let streamId;
            let takenEmail;
            before(async function () {
              streamId = addCustomerPrefixToStreamId('email');

              // Create user1 — their email is registered in PlatformDB via insertOne
              const user1 = await createUser();
              takenEmail = user1.attrs.email;

              // Create user2 and try to use user1's email
              await createUser();
              eventData = {
                streamIds: [streamId],
                content: takenEmail,
                type: 'string/pryv'
              };
              res = await request.post(basePath)
                .send(eventData)
                .set('authorization', access.token);
            });

            it('[2021] should return a 409 error', () => {
              assert.strictEqual(res.status, 409);
            });
            it('[121E] should return the correct error', () => {
              assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
              assert.deepStrictEqual(res.body.error.data, { email: takenEmail });
            });
          });
        });
      });

      describe('[ED22] to create a non editable system event', () => {
        before(async () => {
          await createUser();
          eventData = {
            streamIds: [':_system:dbDocuments'],
            content: charlatan.Lorem.characters(7),
            type: 'password-hash/string'
          };

          res = await request.post(basePath)
            .send(eventData)
            .set('authorization', access.token);
        });
        it('[6CE0] should return a 400 error', () => {
          assert.strictEqual(res.status, 400);
        });
        it('[90E6] should return the correct error', () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
          assert.deepStrictEqual(res.body.error.data, { streamId: ':_system:dbDocuments' });
          assert.strictEqual(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
        });
      });
    });

    describe('[ED23] when using a shared access with a contribute-level permission on a system stream', () => {
      let sharedAccess;
      const streamId = 'email';
      let systemStreamId;
      before(async function () {
        systemStreamId = addCustomerPrefixToStreamId(streamId);
        const user2 = await createUser();
        sharedAccess = await user2.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: systemStreamId,
            level: 'contribute'
          }]
        });

        eventData = {
          streamIds: [systemStreamId],
          content: charlatan.Lorem.characters(7),
          type: 'string/pryv'
        };

        res = await request.post(basePath)
          .send(eventData)
          .set('authorization', sharedAccess.attrs.token);
      });

      it('[X49R] should return 201', () => {
        assert.strictEqual(res.status, 201);
      });
      it('[764A] should return the created event', () => {
        assert.strictEqual(res.body.event.createdBy, sharedAccess.attrs.id);
        assert.deepStrictEqual(res.body.event.streamIds, [systemStreamId]);
      });
    });

    describe('[ED24] when using a shared access with a manage-level permission on all streams (star)', () => {
      let sharedAccess;
      let systemStreamId;
      before(async function () {
        systemStreamId = addCustomerPrefixToStreamId('email');
        await createUser();
        sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });

        eventData = {
          streamIds: [systemStreamId],
          content: charlatan.Lorem.characters(7),
          type: 'string/pryv'
        };

        res = await request.post(basePath)
          .send(eventData)
          .set('authorization', sharedAccess.attrs.token);
      });

      it('[YX07] should return 403', () => {
        assert.strictEqual(res.status, 403);
      });
      it('[YYU1] should return correct error id', () => {
        assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      });
    });
  });

  describe('[ED08] PUT /events/<id>', () => {
    describe('[ED25] when using a personal access', () => {
      describe('[ED26] to update an editable system event', () => {
        async function editEvent (streamId, isFaulty = false) {
          eventData = {
            streamIds: [streamId],
            content: isFaulty ? { someProp: 123 } : charlatan.Lorem.characters(7),
            type: 'string/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, streamId);

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', access.token);
          return res;
        }

        describe('[ED27] which is non indexed and non unique', () => {
          before(async function () {
            await createUser();
            eventData = {
              content: charlatan.Lorem.characters(7),
              type: 'string/pryv'
            };
            const initialEvent = await getOneEvent(user.attrs.id, addCustomerPrefixToStreamId('phoneNumber'));

            res = await request.put(path.join(basePath, initialEvent.id))
              .send(eventData)
              .set('authorization', access.token);
          });
          it('[2FA2] should return 200', () => {
            assert.strictEqual(res.status, 200);
          });
          it('[763A] should return the updated event', () => {
            assert.strictEqual(res.body.event.content, eventData.content);
            assert.strictEqual(res.body.event.type, eventData.type);
            assert.deepStrictEqual(res.body.event.streamIds, [
              addCustomerPrefixToStreamId('phoneNumber')]);
          });

          describe('[ED29] by changing its steamIds', () => {
            describe('[ED30] when editing with 2 streamIds at the time', () => {
              let streamIds;
              before(async function () {
                streamIds = [
                  addCustomerPrefixToStreamId('email'),
                  addCustomerPrefixToStreamId('phoneNumber')
                ];
                await createUser();
                eventData = {
                  streamIds,
                  content: charlatan.Lorem.characters(7),
                  type: 'string/pryv'
                };
                const initialEvent = await getOneEvent(user.attrs.id, addCustomerPrefixToStreamId('phoneNumber'));
                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[8BFK] should return 400', () => {
                assert.strictEqual(res.status, 400);
              });
              it('[E3KE] should return the correct error', () => {
                assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
                assert.strictEqual(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams]);
                assert.ok(streamIds.every(id => res.body.error.data.streamIds.includes(id)));
              });
            });
            describe('[ED31] when substituting a system stream with another one', () => {
              before(async function () {
                await createUser();
                eventData = {
                  streamIds: [addCustomerPrefixToStreamId('email')],
                  content: charlatan.Lorem.characters(7),
                  type: 'string/pryv'
                };
                const initialEvent = await await getOneEvent(user.attrs.id, addCustomerPrefixToStreamId('phoneNumber'));

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[9004] should return 400', () => {
                assert.strictEqual(res.status, 400);
              });
              it('[E3AE] should return the correct error', () => {
                assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
                assert.strictEqual(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
              });
            });
          });
        });

        describe('[ED32] which is indexed', function () {
          describe('[ED33] as register is working', () => {
            describe('[ED34] when the new value is valid', () => {
              const streamId = 'language';
              let systemStreamId;
              before(async function () {
                systemStreamId = addPrivatePrefixToStreamId(streamId);
                await createUser();
                await editEvent(systemStreamId);
              });
              it('[0RUK] should return 200', () => {
                assert.strictEqual(res.status, 200);
              });
            });
            describe('[ED36] when the new value is invalid', () => {
              const streamId = 'language';
              let systemStreamId;
              before(async function () {
                systemStreamId = addPrivatePrefixToStreamId(streamId);
                await createUser();
                await editEvent(systemStreamId, true);
              });
              it('[RDZF] should return 400', () => {
                assert.strictEqual(res.status, 400);
              });
            });
          });
          describe('[ED37] without external register (PlatformDB handles all)', () => {
            const streamId = 'language';
            let systemStreamId;
            before(async function () {
              systemStreamId = addPrivatePrefixToStreamId(streamId);
              await createUser();
              await editEvent(systemStreamId);
            });
            it('[AA92] should return 200', () => {
              assert.strictEqual(res.status, 200);
            });
          });
        });

        describe('[ED38] which is unique', () => {
          describe('[ED39] by updating a unique field that is valid', () => {
            const streamId = 'email';
            let systemStreamId;
            before(async function () {
              systemStreamId = addCustomerPrefixToStreamId(streamId);
              await createUser();
              await editEvent(systemStreamId);
            });
            it('[4BB1] should return 200', () => {
              assert.strictEqual(res.status, 200);
            });
          });
          describe('[ED41] by updating a unique field that is already taken', () => {
            describe('[ED42] with a field that is already taken by another user', () => {
              let systemStreamId;
              before(async function () {
                const streamId = 'email';
                systemStreamId = addCustomerPrefixToStreamId(streamId);

                // Create user1 — their email is already in PlatformDB
                const user1 = await createUser();
                const takenEmail = user1.attrs.email;

                // Create user2 and try to update their email to user1's email
                await createUser();
                eventData = {
                  streamIds: [systemStreamId],
                  content: takenEmail,
                  type: 'string/pryv'
                };
                const initialEvent = await getOneEvent(user.attrs.id, systemStreamId);

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[F8A8] should return 409', () => {
                assert.strictEqual(res.status, 409);
                assert.strictEqual(res.body.error.id, ErrorIds.ItemAlreadyExists);
                assert.deepStrictEqual(res.body.error.data, { email: eventData.content });
              });
            });
            describe('[ED43] with a field that is not unique in mongodb', () => {
              before(async function () {
                const streamId = addCustomerPrefixToStreamId('email');
                const user1 = await createUser();
                const user2 = await createUser();
                eventData = {
                  streamIds: [streamId],
                  content: user1.attrs.email,
                  type: 'string/pryv'
                };
                const initialEvent = await getOneEvent(user2.attrs.id, streamId);

                res = await request.put(path.join(basePath, initialEvent.id))
                  .send(eventData)
                  .set('authorization', access.token);
              });
              it('[5782] should return 409', () => {
                assert.strictEqual(res.status, 409);
              });
              it('[B285] should return the correct error', () => {
                const error = res.body.error;
                assert.strictEqual(error.id, ErrorIds.ItemAlreadyExists);
                assert.strictEqual(error.data.email, eventData.content);
              });
            });
          });
        });
      });

      describe('[ED44] to update a non editable system event', () => {
        before(async function () {
          await createUser();
          eventData = {
            content: charlatan.Lorem.characters(7),
            type: 'password-hash/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, addPrivatePrefixToStreamId('invitationToken'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', access.token);
        });
        it('[034D] should return 400', () => {
          assert.strictEqual(res.status, 400);
        });
        it('[BB5F] should return the correct error', () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
          assert.strictEqual(res.body.error.message, ErrorMessages[ErrorIds.ForbiddenAccountEventModification]);
          assert.deepStrictEqual(res.body.error.data, { streamId: addPrivatePrefixToStreamId('invitationToken') });
        });
      });
    });
    describe('[ED45] when using a shared access with a contribute-level access on a system stream', () => {
      describe('[ED46] to update an editable system event', () => {
        before(async function () {
          const user2 = await createUser();
          const sharedAccess = await user2.access({
            token: cuid(),
            type: 'shared',
            permissions: [{
              streamId: addCustomerPrefixToStreamId('phoneNumber'),
              level: 'contribute'
            }]
          });
          eventData = {
            content: charlatan.Internet.email()
          };
          const initialEvent = await getOneEvent(user.attrs.id, addCustomerPrefixToStreamId('phoneNumber'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', sharedAccess.attrs.token);
        });
        it('[W8PQ] should return 200', () => {
          assert.strictEqual(res.status, 200);
        });
        it('[TFOI] should return the updated event', () => {
          assert.strictEqual(res.body.event.content, eventData.content);
          assert.deepStrictEqual(res.body.event.streamIds, [
            addCustomerPrefixToStreamId('phoneNumber')]);
        });
      });
    });
    describe('[ED47] when using a shared access with a manage-level permission on all streams (star)', () => {
      describe('[ED48] to update an editable system event', () => {
        before(async function () {
          await createUser();
          const sharedAccess = await user.access({
            token: cuid(),
            type: 'shared',
            permissions: [{
              streamId: '*',
              level: 'manage'
            }]
          });
          eventData = {
            content: charlatan.Lorem.characters(7),
            type: 'string/pryv'
          };
          const initialEvent = await getOneEvent(user.attrs.id, addCustomerPrefixToStreamId('phoneNumber'));

          res = await request.put(path.join(basePath, initialEvent.id))
            .send(eventData)
            .set('authorization', sharedAccess.attrs.token);
        });
        it('[H1XL] should return 403', () => {
          assert.strictEqual(res.status, 403);
        });
        it('[7QA3] should return the correct error', () => {
          assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
        });
      });
    });
  });

  describe('[ED09] DELETE /events/<id>', () => {
    describe('[ED49] When using a personal access', () => {
      describe('[ED50] to delete an account event', () => {
        describe('[ED52] which is unique', () => {
          const streamId = 'email';
          let systemStreamId;
          let initialEvent;
          before(async function () {
            systemStreamId = addCustomerPrefixToStreamId(streamId);
            await createUser();
            initialEvent = await getOneEvent(user.attrs.id, systemStreamId);
            res = await request.delete(path.join(basePath, initialEvent.id))
              .set('authorization', access.token);
          });
          it('[43B1] should return 400', () => {
            assert.strictEqual(res.status, 400);
          });
          it('[3E12] should return the correct error', () => {
            assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
          });
        });
        describe('[ED53] which is indexed', () => {
          let streamId;
          let initialEvent;
          before(async function () {
            streamId = addPrivatePrefixToStreamId('language');
            await createUser();
            initialEvent = await getOneEvent(user.attrs.id, streamId);
            res = await request.delete(path.join(basePath, initialEvent.id))
              .set('authorization', access.token);
          });
          it('[1B70] should return 400', () => {
            assert.strictEqual(res.status, 400);
          });
          it('[CBB9] should return the correct error', () => {
            assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
          });
        });
      });
      describe('[ED55] to delete a non editable system event', () => {
        let streamId;
        let initialEvent;
        before(async function () {
          streamId = addPrivatePrefixToStreamId('dbDocuments');
          await createUser();
          initialEvent = await getOneEvent(user.attrs.id, streamId);
          res = await request.delete(path.join(basePath, initialEvent.id))
            .set('authorization', access.token);
        });
        it('[8EDB] should return a 400', () => {
          assert.strictEqual(res.status, 400);
        });
        it('[A727] should return the correct error', () => {
          assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
        });
      });
    });

    describe('[ED56] when using a shared access with a contribute-level access on a system stream', () => {
      let streamId;
      let initialEvent;
      before(async function () {
        streamId = addPrivatePrefixToStreamId('language');
        await createUser();
        initialEvent = await getOneEvent(user.attrs.id, streamId);
        res = await request.delete(path.join(basePath, initialEvent.id))
          .set('authorization', access.token);
      });
      it('[I1I1] should return 400', () => {
        assert.strictEqual(res.status, 400);
      });
      it('[UFLT] should return the correct error', () => {
        assert.strictEqual(res.body.error.id, ErrorIds.InvalidOperation);
      });
    });

    describe('[ED57] when using a shared access with a manage-level permission on all streams (star)', () => {
      const streamId = 'email';
      let systemStreamId;
      let initialEvent;
      before(async function () {
        systemStreamId = addCustomerPrefixToStreamId(streamId);
        await createUser();
        initialEvent = await getOneEvent(user.attrs.id, systemStreamId);

        const sharedAccess = await user.access({
          token: cuid(),
          type: 'shared',
          permissions: [{
            streamId: '*',
            level: 'manage'
          }]
        });

        res = await request.delete(path.join(basePath, initialEvent.id))
          .set('authorization', sharedAccess.attrs.token);
      });
      it('[AT1E] should return 403', () => {
        assert.strictEqual(res.status, 403);
      });
      it('[FV8W] should return the correct error', () => {
        assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);
      });
    });
  });
});
