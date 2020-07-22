var logger = require('winston');
var database = require('./storage/database');
var config = require('./config');
var messages = require('./utils/messages');
logger['default'].transports.console.level = 'info';

const headPath = require('components/api-server/src/routes/Paths').Register;

class mockExpress {
  constructor(expressApp) {
    this.app = expressApp; 
  }

  use(fn) {
    this.app.use(fn);
  }

  get(path, cb1, cb2) {
    if (cb2) {
      return this.app.get(headPath + path, cb1, cb2);
    }
    this.app.get(headPath + path, cb1);
  }

  post(path, cb1, cb2) {
    if (cb2) {
      return this.app.post(headPath + path, cb1, cb2);
    }
    this.app.post(headPath + path, cb1);
  }
}

module.exports = async (expressApp, application) => {
  config.loadSettings(application.settings);
  database.setReference('storage', application.storageLayer);
  database.setReference('systemAPI', application.systemAPI);
  
  const app = new mockExpress(expressApp);
  // public API routes
  require('./routes/email')(app);
  require('./routes/service')(app);
  require('./routes/users')(app);
  require('./routes/access')(app);
  require('./routes/admin')(app);
  require('./routes/server')(app); // only used for backwards compatiblity with DNS set-up
  require('./middleware/app-errors')(app);

  // register all reg routes
  expressApp.all(headPath + '/*', function (req, res, next) {
    res.status(404).send({ id: 'unkown-route', message: 'Unknown route: ' + req.path });
  });
}