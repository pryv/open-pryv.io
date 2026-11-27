/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Pins, per storage type, the interface version next to the contract an
 * engine must meet: the engine module's required exports (pluginLoader's
 * REQUIRED_EXPORTS) and the required methods of each interface object, as
 * the interface validators check them. A contract change without a version
 * decision fails here. When to bump: ../interfaces/README.md.
 */

import assert from 'node:assert';
import { INTERFACE_VERSIONS } from '../interfaces/versions.ts';
import { REQUIRED_EXPORTS } from '../pluginLoader.ts';
import { validateDeletionNoticesLocalDB } from '../interfaces/baseStorage/DeletionNoticesLocalDB.ts';
import { validateErasuresLocalDB } from '../interfaces/baseStorage/ErasuresLocalDB.ts';
import { validateExternalIdsLocalDB } from '../interfaces/baseStorage/ExternalIdsLocalDB.ts';
import { validatePasswordResetRequests } from '../interfaces/baseStorage/PasswordResetRequests.ts';
import { validateSessions } from '../interfaces/baseStorage/Sessions.ts';
import { UserAccountStorage } from '../interfaces/baseStorage/UserAccountStorage.ts';
import { validateUserStorage } from '../interfaces/baseStorage/UserStorage.ts';
import { validateUsersLocalIndexDB } from '../interfaces/baseStorage/UsersLocalIndexDB.ts';
import { validatePlatformDB } from '../interfaces/platformStorage/PlatformDB.ts';
import { validateSeriesConnection } from '../interfaces/seriesStorage/SeriesConnection.ts';
import { validateEventFiles } from '../interfaces/fileStorage/EventFiles.ts';
import { validateAuditStorage } from '../interfaces/auditStorage/AuditStorage.ts';
import { validateUserAuditDatabase } from '../interfaces/auditStorage/UserAuditDatabase.ts';

const PINS = {
  baseStorage: {
    version: 1,
    exports: ['getUserAccountStorage', 'getUsersLocalIndex', 'initStorageLayer'],
    interfaces: {
      DeletionNoticesLocalDB: [
        'countPending',
        'delete',
        'deleteAll',
        'init',
        'insert',
        'listAll',
        'listDue',
        'pruneFailedBefore',
        'update'
      ],
      ErasuresLocalDB: [
        'claim',
        'delete',
        'deleteAll',
        'get',
        'init',
        'insertIfAbsent',
        'listAll',
        'put'
      ],
      ExternalIdsLocalDB: [
        'deleteAll',
        'deleteByTokens',
        'deleteByUser',
        'deleteByUserAndNamespace',
        'getByTokens',
        'getByUser',
        'getByUserAndNamespace',
        'init',
        'insert',
        'replaceForUser',
        'retoken',
        'scanAll'
      ],
      PasswordResetRequests: [
        'clearAll',
        'consume',
        'destroy',
        'destroyAllForUser',
        'exportAll',
        'generate',
        'get',
        'importAll'
      ],
      Sessions: [
        'clearAll',
        'destroy',
        'expireNow',
        'exportAll',
        'generate',
        'get',
        'getMatching',
        'importAll',
        'remove',
        'removeAllExcept',
        'touch'
      ],
      UserAccountStorage: [
        '_clearAll',
        '_exportAll',
        '_importAll',
        'addPasswordHash',
        'clearHistory',
        'closeUser',
        'deleteAccountField',
        'getAccountField',
        'getAccountFieldHistory',
        'getAccountFields',
        'getAccountFieldsWithMeta',
        'getCurrentPasswordTime',
        'getKeyValueDataForStore',
        'getPasswordHash',
        'init',
        'passwordExistsInHistory',
        'setAccountField'
      ],
      UserStorage: [
        'clearAll',
        'compareAndSetJson',
        'count',
        'countAll',
        'delete',
        'exportAll',
        'find',
        'findDeletions',
        'findOne',
        'findOneAndUpdate',
        'getCollectionInfo',
        'importAll',
        'insertOne',
        'iterateAll',
        'removeAll',
        'removeMany',
        'removeOne',
        'updateMany',
        'updateOne'
      ],
      UsersLocalIndexDB: [
        'addAlias',
        'addUser',
        'clearAll',
        'deleteAlias',
        'deleteAliasesForId',
        'deleteAll',
        'deleteById',
        'exportAll',
        'getAliasesForId',
        'getAllByUsername',
        'getIdForAlias',
        'getIdForName',
        'getNameForId',
        'importAll',
        'init',
        'renameUser'
      ]
    }
  },
  dataStore: {
    version: 1,
    exports: ['getDataStoreModule'],
    // The DataStore object itself is defined and versioned by the
    // @pryv/datastore SDK; this server holds no method list for it.
    interfaces: {}
  },
  platformStorage: {
    version: 2,
    exports: ['createPlatformDB'],
    interfaces: {
      PlatformDB: [
        'bumpWindowedCounter',
        'checkStoreIntegrity',
        'claimCoreRow',
        'claimInvitationToken',
        'clearAll',
        'close',
        'consumeAccessState',
        'createInvitationToken',
        'deleteAccessState',
        'deleteAll',
        'deleteCertificate',
        'deleteCoreRowIfValue',
        'deleteDnsRecord',
        'deleteInvitationToken',
        'deleteMailTemplate',
        'deleteObservabilityValue',
        'deletePlatformKv',
        'deleteUserCore',
        'deleteUserIndexedField',
        'deleteUserUniqueField',
        'exportAll',
        'getAccessState',
        'getAcmeAccount',
        'getAllCoreInfos',
        'getAllCoreRows',
        'getAllDnsRecords',
        'getAllForUser',
        'getAllInvitationTokens',
        'getAllMailTemplates',
        'getAllObservabilityValues',
        'getAllUserCores',
        'getAllWithPrefix',
        'getCertificate',
        'getCoreInfo',
        'getCoreRow',
        'getDnsRecord',
        'getInvitationToken',
        'getMailTemplate',
        'getObservabilityValue',
        'getPlatformKv',
        'getUserCore',
        'getUserIndexedField',
        'getUsersUniqueField',
        'getUsersUniqueFieldAnyCase',
        'importAll',
        'init',
        'isClosed',
        'listAllPlatformKvEntries',
        'listCertificates',
        'listExpiredAccessStates',
        'listPlatformKvEntries',
        'listPlatformKvKeys',
        'moveCoreRows',
        'reassignInvitationConsumer',
        'releaseInvitationToken',
        'releaseWindowedCounter',
        'replacePlatformKvIfValue',
        'setAccessState',
        'setAccessStateIfAbsent',
        'setAcmeAccount',
        'setCertificate',
        'setCoreInfo',
        'setDnsRecord',
        'setMailTemplate',
        'setObservabilityValue',
        'setPlatformKv',
        'setPlatformKvIfAbsent',
        'setUserCore',
        'setUserCoreIfNotExists',
        'setUserIndexedField',
        'setUserUniqueField',
        'setUserUniqueFieldIfNotExists',
        'sweepExpiredAccessStates',
        'sweepExpiredWindowedCounters',
        'updateInvitationToken'
      ]
    }
  },
  seriesStorage: {
    version: 1,
    exports: ['createSeriesConnection'],
    interfaces: {
      SeriesConnection: [
        'createDatabase',
        'dropDatabase',
        'dropMeasurement',
        'getDatabases',
        'query',
        'renameDatabase',
        'writeMeasurement',
        'writePoints'
      ]
    }
  },
  fileStorage: {
    version: 1,
    exports: ['createFileStorage'],
    interfaces: {
      EventFiles: [
        'attachToEventStore',
        'getAttachmentStream',
        'getFileStorageInfos',
        'init',
        'removeAllForEvent',
        'removeAllForUser',
        'removeAttachment',
        'saveAttachmentFromStream'
      ]
    }
  },
  auditStorage: {
    version: 1,
    exports: ['createAuditStorage'],
    interfaces: {
      AuditStorage: [
        'checkInitialized',
        'close',
        'deleteUser',
        'forUser',
        'getVersion',
        'init'
      ],
      UserAuditDatabase: [
        'close',
        'countEvents',
        'createEvent',
        'createEventSync',
        'deleteEventHistory',
        'deleteEvents',
        'exportAllEvents',
        'getAllAccesses',
        'getAllActions',
        'getEventDeletionsStreamed',
        'getEventHistory',
        'getEvents',
        'getEventsStreamed',
        'getOneEvent',
        'importAllEvents',
        'init',
        'minimizeEventHistory',
        'summarize',
        'updateEvent'
      ]
    }
  }
};

/**
 * The method names a validator checks: it is handed an object that records
 * every property read and answers each with a function, so it passes after
 * reading exactly its required list.
 */
function methodsCheckedBy (validate) {
  const seen = [];
  const recorder = new Proxy({}, {
    get (target, key) {
      if (typeof key === 'string') seen.push(key);
      return function () {};
    }
  });
  validate(recorder);
  return seen;
}

// storage type -> interface name -> live required-method list
const LIVE = {
  baseStorage: {
    DeletionNoticesLocalDB: () => methodsCheckedBy(validateDeletionNoticesLocalDB),
    ErasuresLocalDB: () => methodsCheckedBy(validateErasuresLocalDB),
    ExternalIdsLocalDB: () => methodsCheckedBy(validateExternalIdsLocalDB),
    PasswordResetRequests: () => methodsCheckedBy(validatePasswordResetRequests),
    Sessions: () => methodsCheckedBy(validateSessions),
    // No validator: engines build it from this prototype object
    // (createUserAccountStorage), so its own methods are the contract.
    UserAccountStorage: () => Object.getOwnPropertyNames(UserAccountStorage),
    UserStorage: () => methodsCheckedBy(validateUserStorage),
    UsersLocalIndexDB: () => methodsCheckedBy(validateUsersLocalIndexDB)
  },
  dataStore: {},
  platformStorage: {
    PlatformDB: () => methodsCheckedBy(validatePlatformDB)
  },
  seriesStorage: {
    SeriesConnection: () => methodsCheckedBy(validateSeriesConnection)
  },
  fileStorage: {
    EventFiles: () => methodsCheckedBy(validateEventFiles)
  },
  auditStorage: {
    AuditStorage: () => methodsCheckedBy(validateAuditStorage),
    UserAuditDatabase: () => methodsCheckedBy(validateUserAuditDatabase)
  }
};

function changedMessage (type, what, live, pinned) {
  const added = live.filter((m) => !pinned.includes(m));
  const removed = pinned.filter((m) => !live.includes(m));
  return `the required methods of ${type} changed (${what}: added [${added.join(', ')}], removed [${removed.join(', ')}]): ` +
    `bump INTERFACE_VERSIONS.${type} in storages/interfaces/versions.ts if the change breaks engines, ` +
    'then update this table (storages/test/interface-method-pins.test.js) and the README history (storages/interfaces/README.md)';
}

function assertSameSet (type, what, live, pinned) {
  assert.strictEqual(new Set(live).size, live.length, `${type} ${what}: the live list has duplicates`);
  if (live.length === pinned.length && live.every((m) => pinned.includes(m))) return;
  assert.fail(changedMessage(type, what, live, pinned));
}

// Pure unit tests: no database.
describe('[IFPN] Storage interface contract pins', () => {
  it('[IFPA] the pin table covers exactly the storage types of INTERFACE_VERSIONS', () => {
    const types = Object.keys(INTERFACE_VERSIONS).sort();
    assert.deepStrictEqual(Object.keys(PINS).sort(), types);
    assert.deepStrictEqual(Object.keys(LIVE).sort(), types);
    for (const type of types) {
      assert.deepStrictEqual(Object.keys(LIVE[type]).sort(), Object.keys(PINS[type].interfaces).sort(),
        `${type}: the pinned interfaces and the live sources differ`);
    }
  });

  it('[IFPB] each pinned version equals INTERFACE_VERSIONS', () => {
    for (const [type, pin] of Object.entries(PINS)) {
      assert.strictEqual(pin.version, INTERFACE_VERSIONS[type],
        `INTERFACE_VERSIONS.${type} is ${INTERFACE_VERSIONS[type]}, this table pins ${pin.version}: ` +
        `update the pinned version and required methods of ${type} in this table, and the README history (storages/interfaces/README.md)`);
    }
  });

  it('[IFPC] each type\'s required engine exports equal the pinned list', () => {
    for (const [type, pin] of Object.entries(PINS)) {
      assertSameSet(type, 'engine exports (pluginLoader REQUIRED_EXPORTS)', REQUIRED_EXPORTS[type] || [], pin.exports);
    }
  });

  it('[IFPD] each interface\'s required methods equal the pinned list', () => {
    for (const [type, pin] of Object.entries(PINS)) {
      for (const [iface, pinned] of Object.entries(pin.interfaces)) {
        assertSameSet(type, iface, LIVE[type][iface](), pinned);
      }
    }
  });
});
