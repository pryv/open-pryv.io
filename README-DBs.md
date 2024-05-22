# Pryv.io Databases

Initially Pryv.io was built on top of MongoDB with separated collection per user. This initial design allowed to isolate peruser data on the file system. 

This design has a drawback as MongoDB was consuming a fixed amount of RAM per collection and the with growing sets of users (over 40'000 per node) 16Gb was needed. In v1.6.0 an option to merge the Mongo's collection was added, resulting in an average RAM requirement of 4Gb for 100'000 users. 

From v1.7.0 Sqlite has been investigated in order to provide  back the ability to isolate peruser data on the file system. The motivation is to provide full control over the user's data in order to facilitate and prove the "right to be forgotten."

From v1.8.0 a Sqlite version for Event has been provided on top of the [datastore](https://github.com/pryv/pryv-datastore) abstraction. 

From v1.9.x [FerretDB](https://www.ferretdb.com) has been implemented as on optional replacement of MongoDB. 

Since v1.9.2 Pryv.io can be deployed in "full-cloud" setup without relying on the file system. This can be done by configuring all storage modules to use MongoDB. For the attachments and S3 implementation is in development. 

For future v1.9.3 Pryv.io will be also capable in being "full local" with only SQLite databases. 

## List of storage used in Pryv.io

#### User local directory

base code: [components/storage/src/userLocalDirectory.js](components/storage/src/userLocalDirectory.js)

Localization of user data on the host file system, usually in `var-pryv/users` then a directory path is constructed using the 3 last characters of the userId and the userId. 

Exemple with userId `c123456789abc`: `var-pryv/users/c/b/a/c123456789abc/`

In this directory, the attachments and any user attributed data and sqlite db should be stored.

#### User local index

base code: [components/storage/src/userLocalIndex.js](components/storage/src/userLocalIndex.js)

This database is a per-server index to map userId and userName. In the future it could be extended to allow user aliases. 

- With SQLite (default) the db file can be usually found at `var-pryv/user-index.db`
- With MongoDB the collection is `id4name` and stored in the main host database `pryv-node`

Settings to activate MongoDB/ferretDB instead of SQLite: `storageUserIndex:engine = 'mongodb'`

Script to migrate userIndex from SQLite to MongoDB:  [read first](#sql2mongo)
`LOGS=info node components/storage/src/migrations/switchSqliteMongo/usersIndex.js --config configs/api.yml`

#### User account storage

base code: [components/storage/src/userAccountStorage*.js](components/storage/src/)  *: Mongo or Sqlite

This database contains the password and passwords history of the user. 

- With SQLite (default) it can be found in the "User local directory" named as `account-1.0.0.sqlite` . 
- With MongoDB the collection is `passwords` and stored in the main host database `pryv-node`

Settings to activate MongoDB/ferretDB instead of SQLite: `storageUserAccount:engine = 'mongodb'`

Script to migrate from SQLite to MongoDB:  [read first](#sql2mongo)
`LOGS=info node components/storage/src/migrations/switchSqliteMongo/userAccountStorage.js --config configs/api.yml`

#### Platform Wide Shared Storage

base code: [components/platform](components/platform)

This database contains all indexed and unique fields for users such as emails and custom systems streams data.

In the Enterprise version of Pryv, it acts as a local cache and report to `service-register` being the main index. For Open-Pryv.io platformDB should evolve in a shared database between running service-core. 

- With SQLite (default) the db file can be usually found at `var-pryv/platform-wide.db`
- With MongoDB 

Settings to activate MongoDB/ferretDB instead of SQLite:`storagePlatform:engine = 'mongodb'`

Script to migrate from SQLite to MongoDB: [read first](#sql2mongo)

`LOGS=info node components/storage/src/migrations/switchSqliteMongo/platformDB.js --config configs/api.yml`

#### Events, Streams & Attachments Storage

base code:  [components/storage/src/localDataStore](components/storage/src/localDataStore)  and [localDataStoreSQLite](components/storage/src/localDataStoreSqlite)

Main storage for `events` ,  `streams`  & `attachments` this implementation follows the modular API of [datastore](https://github.com/pryv/pryv-datastore) abstraction. 

- Fully implemented with MongoDB/FerretDB
- Only events are implemented with SQLite - Expecting full SQLite implementation in v1.9.3

#### Profile, Accesses, FollowedSlices & Webhooks Storage

base code:  [components/storage/src/user](components/storage/src/user)  

Only implemented for MongoDB/FerretDB - Expecting full SQLite implementation in v1.9.3

### Notes

#### Known issues 

- [ ] test B2I7 is failing when testing `storage` with `full-mongo` as indexes for password is not yet created. Run `just test-full-mongo storage` to reproduce

#### <a name="sql2mongo"/>Using SQlite to MongoDB migration scripts

1. Make sure that all Pryv.io components are stopped but `MongoDB`
2. Do not set the `storage*:engine` setting to `mongodb` yet !
3. Run the scripts
4. Change appropriate setting to  `storage*:engine = 'mongodb'`
5. Start all services and check
6. If all is fine, related SQLite DB should be deleted manually