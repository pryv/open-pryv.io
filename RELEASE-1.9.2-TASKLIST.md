# RELEASE 1.9.2

- Provide a Full-Mongo distribution
- Provide cloud management for Attachments (Files) 
- Provide ferretDB Compantibility to be full Open-Source
- (Optional) provides hooks for encryption mechanisms

## TASKLIST

### Remove 'sqlite' from

- [x] [platform/DB](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/platform/src/) which contains all unique and indexed field. This DB should be distributed among servers
- [x] [userLocalDir](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/storage/src/userLocalDirectory.js) map userId / userName
- [x] [userAccountStorage](https://github.com/pryv/open-pryv.io/full-mongo/master/components/storage/src/userAccountStorage.js) contains password and password history

Task is completed when a script to migrate is provided and settings to activate. 

### Known issues 
- [ ] test B2I7 is failing when testing `storage` with `full-mongo` as indexes for passowrd is not yet created. Run `just test-full-mongo storage` to reproduce

### Move Attachments to an online storage

- [ ] GridFS
- [ ] S3

### Documentation

- [ ] Add instructions on how to move / copy previous user data 
- [ ] Add instructions on how to remove previous configurations associated with user files 

### (Optional) Put all config in MongoDB

- For docker version of open-pryv.io. 
  - default config to be hardcoded in container 
  - Custom value saved in mongoDB, with connection parameters given by `env`   

## Usage

#### Migration scripts

- platform: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/platformDB.js --config configs/api.yml`
- userStorage: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/userAccountStorage.js --config configs/api.yml`
- usersIndex: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/usersIndex.js --config configs/api.yml`

#### Settings

- Platform: `storagePlatform:engine = 'mongodb'`
- userStorage: `storageUserAccount:engine = 'mongodb'`
- storageUserIndex: `storageUserIndex:engine = 'mongodb'`

### Know issue
- [ ] B2I7 **storage** test is failing after migrations test because indexes are lost. But runs fine idenpendently. 

## Log

27/03/2024 - Made a MongoDB version of platform/DB 

- migrated in a sperated db: `pryv-node-platform` as it should behave differntly that user-based DB (`pryv-node`). 
- Collections are: `keyValueIndexed`  and `keyValueUnique` 

27/03/2024 - Made a MongoDB verion of userStorage 

- migrated to in `pryv-node` in collections `passwords` & `stores-key-value`

28/03/2024 - Made a MongoDB verion of userIndex 

- migrated to in `pryv-node` in collection `id4name` 
