// prototype, run the following command to test
// node components/platform/src/switch1.9.0sqlite-mongo.js --config config/api.yml

const { getApplication } = require('api-server/src/application');

async function switchDB () {
  const Sqlite = require('./DB');
  const Mongo = require('./DBmongodb');

  const app = getApplication();
  await app.initiate();

  const sqlite = new Sqlite();
  await sqlite.init();
  const mongo = new Mongo();
  await mongo.init();

  const users = await sqlite.getAllWithPrefix('user');
  for (const user of users) {
    if (user.isUnique) {
      await mongo.setUserUniqueField(user.username, user.field, user.value);
      await sqlite.deleteUserUniqueField(user.field, user.value);
    } else {
      await mongo.setUserIndexedField(user.username, user.field, user.value);
      await sqlite.deleteUserIndexedField(user.username, user.field);
    }
  }
  console.log('Transfered to mongo ' + users.length + ' users');
  process.exit(0);
}

switchDB();
