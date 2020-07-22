// Load configuration file and start the server. 

const assert = require('assert');
const yargs = require('yargs');
const path = require('path');

const logging = require('./logging');
const Context = require('./context');
const Settings = require('./settings');
const Server = require('./server'); 

/** The mailing application holds references to all subsystems and ties everything
 * together. 
 */
class Application {
  
  async initSettings(overrideSettings) {
    this.settings = new Settings(); 

    await this.parseCLargs(process.argv);

    if (overrideSettings != null) {
      this.settings.merge(overrideSettings);
    }
    
    assert(this.settings != null, 'AF: settings init has succeeded');
  }
  
  // Parses the configuration on the command line (arguments).
  // 
  async parseCLargs(argv) {
    const cli = yargs
      .option('c', {
        alias: 'config', 
        type: 'string', 
        describe: 'reads configuration file at PATH'
      })
      .usage('$0 [args] \n\n  starts a metadata service')
      .help();      
    
    const out = cli.parse(argv);
    
    if (out.config != null) {
      const configPath = path.resolve(out.config);
      await this.settings.loadFromFile(configPath);
    }
  }
  
  initLogger() {
    const settings = this.settings;
    const logSettings = settings.get('logs');
    const logFactory = this.logFactory = logging(logSettings).getLogger;
    const logger = this.logger = logFactory('application');
    const consoleLevel = settings.get('logs.console.level');
    
    assert(this.logger != null, 'AF: logger init has succeeded');
    logger.info(`Console logging is configured at level '${consoleLevel}'`);
  }
  
  initContext() {    
    this.context = new Context(this.settings, this.logFactory);
    
    assert(this.context != null, 'AF: context init has succeeded');
    this.logger.info('Context initialized.');
  }
  
  async setup(overrideSettings) {
    
    await this.initSettings(overrideSettings);
    this.initLogger();
    this.initContext();
    
    this.server = new Server(this.settings, this.context);
    
    return this; 
  }
  
  async run() {
    await this.server.start(); 
  }
  
  async close() {
    await this.server.stop(); 
  }
}

module.exports = Application; 
