# Provide a Full-Mongo distribution

## TASKLIST

### Remove 'sqlite' from

- [x] [platform/DB](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/platform/src/) which contains all unique and indexed field. This DB should be distributed among servers
- [x] [userLocalDir](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/storage/src/userLocalDirectory.js) map userId / userName
- [x] [userAccountStorage](https://github.com/pryv/open-pryv.io/full-mongo/master/components/storage/src/userAccountStorage.js) contains password and password history

Task is completed when a script to migrate is provided and settings to activate. 

### Move Attachments to an online storage

- [ ] GridFS
- [ ] S3

### (Optional) Put all config in MongoDB

- For docker version of onpen-pryv.io. 
  - default config to be hardcoded in container 
  - Custom value saved in mongoDB, with connection parameters given by `env`   

## Usage

#### Migration scripts

- platform: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/platformDB.js --config configs/api.yml`
- userStorage: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/userAccountStorage.js --config configs/api.yml`
- userIndex: `LOGS=info node components/storage/src/migrations/switchSqliteMongo/userIndex.js --config configs/api.yml`

#### Settings

- Platform: ``storagePlatform:engine = 'mongodb'`
- userStorage: ``storageUserAccount:engine = 'mongodb'`
- storageUserIndex: `storageUserIndex:engine = 'mongodb'`

### Know issue
- [ ] B2I7 **storage** test is failing after migrations test because indexes are lost. But runs fine idenpendently. 
- [ ] Tests are running idenpendently but - timing out randomly. I suspect mongoDB connection not being closed. Or indexes buiding for new introduced collections.  

## Log

27/03/2024 - Made a MongoDB version of platform/DB 

- migrated in a sperated db: `pryv-node-platform` as it should behave differntly that user-based DB (`pryv-node`). 
- Collections are: `keyValueIndexed`  and `keyValueUnique` 

27/03/2024 - Made a MongoDB verion of userStorage 

- migrated to in `pryv-node` in collections `passwords` & `stores-key-value`

28/03/2024 - Made a MongoDB verion of userIndex 

- migrated to in `pryv-node` in collection `id4name` 
