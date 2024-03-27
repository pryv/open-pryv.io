# TASKLIST to provide a Full-Mongo distribution

### Remove 'sqlite' from

- [x] [platform/DB](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/platform/src/) which contains all unique and indexed field. This DB should be distributed among servers
- [ ] [userLocalDir](https://github.com/pryv/open-pryv.io/blob/full-mongo/components/storage/src/userLocalDirectory.js) map userId / userName
- [ ] [userAccountStorage](https://github.com/pryv/open-pryv.io/full-mongo/master/components/storage/src/userAccountStorage.js) contains password and password history

Task is completed when a script to migrate is provided and settings to activate. 

### Know issue
- [ ] B2I7 **storage** test is failing after migrations test because indexes are lost. But runs fine idenpendently. 

### Move Attachments to an online storage

- GridFS ? // S3 ??

### (Optional) Put all config in MongoDB

## Log

27/03/2024 - Made a MongoDB of platform/DB 

- migrated to 'pryv-node-platform' as the db should behave differntly that user-based DB.
- can be activated with setting `storagePlatform:engine = 'mongodb'`
- migration with `LOGS=info node components/platform/src/switch1.9.0sqlite-mongo.js --config configs/api.yml`


