const fs = require('fs');
const bluebird = require('bluebird');
const lodash = require('lodash');
const Hjson = require('hjson');
const YAML = require('js-yaml');
const path = require('path');

// -----------------------------------------------------------------------------

// Settings of an application. 
// 
class Settings {
  
  // Constructs a settings object. If `override` is not null, it is merged 
  // on top of the defaults that are in place. 
  // 
  constructor(override) {
    this.config = this.defaults();
    
    if (override != null) 
      lodash.merge(this.config, override);
  }
  defaults() {
    return {
      logs: {
        prefix: '',
        console: { active: true, level: 'info', colorize: true }, 
        file: { active: false },
      },
      // Default values for emails, each email sent will contain these
      email: {
        message: {
          // Default sender name and email address
          from: {
            name: "Ethereal Email",
            address: "changeme@ethereal.email"
          }
        },
        preview: false, // If true, it will open a webpage with a preview
        send: true // Activate/deactivate the actual sending (prod/test env)
      },
      // By default, the service-mail will use SMTP as transport
      smtp: {
        // Host of the external email delivery service
        host: "smtp.ethereal.email",
        // SMTP port
        port: 587,
        /* Credentials to authenticate against external service
        /  We do not set default values here since it prevents
        /  configuring SMTP server with authentication deactivated
        auth: {
          user: "btvryvs5al5mjpa3@ethereal.email",
          pass: "VfNxJctkjrURkyThZr"
        }
        */
      },
      // Alternative transport, using the sendmail command of the machine
      sendmail: {
        // Will replace SMTP transport if set to true
        active: true,
        // Path of the sendmail command on the machine
        path: '/usr/sbin/sendmail'
      },
      http: {
        // IP address on which the mailing server is listening
        ip: "127.0.0.1",
        // Port on which the mailing server is listening
        port: 9000,
        // Each sendmail request should contain authorization header that
        // matches this key, used to prevent abuse.
        auth: "SHOULD_MATCH_SERVICE_MAIL",
        
      },
      templates: {
        // Root folder where the templates are stored
        root: path.resolve('templates'),
        // Default language for templates
        defaultLang: 'en'
      }
    };
  }
  
  // Loads settings from the file `path` and merges them with the settings in 
  // the current instance. 
  // 
  // This uses HJSON under the covers, but will also load from YAML files. 
  //  
  //    -> https://www.npmjs.com/package/hjson
  //    -> https://www.npmjs.com/package/js-yaml
  // 
  async loadFromFile(path) {
    const readFile = bluebird.promisify(fs.readFile);
    const text = await readFile(path, { encoding: 'utf8' });

    let obj;

    if (path.endsWith('.yaml')) 
      obj = YAML.safeLoad(text);
    else 
      obj = Hjson.parse(text);
    
    lodash.merge(this.config, obj);
    
    console.info(`Using configuration file at: ${path}`);
  }
  
  // Merges settings in `other` with the settings stored here. 
  // 
  merge(other) {
    lodash.merge(this.config, other);
  }
  
  get(key) {
    const config = this.config;
    
    if (! lodash.has(config, key)) {
      throw new Error(`Configuration for '${key}' missing.`);
    }

    return lodash.get(config, key);
  }
  
  has(key) {
    const config = this.config;

    return lodash.has(config, key);
  }
  
}

module.exports = Settings;

