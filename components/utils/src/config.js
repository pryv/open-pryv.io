/* jshint -W024 */
var convict = require('convict'),
    fs = require('fs'),
    path = require('path'),
    toString = require('./toString'),
    _ = require('lodash'), 
    ServiceInfo = require('./config/ServiceInfo');

var config = module.exports = {};

/**
 * Additional setting format definitions.
 */
var formats = config.formats = {
  logLevel: [ 'debug', 'info', 'warn', 'error' ]
};

/**
 * Base settings schema. Extend at will.
 */
config.schema = {
  openSource: {
    isActive: {
      format: Boolean,
      default: false,
      doc: 'Used when webhooks and HFS are not available to cut off unavailble dependencies that would make the service crash.'
    }
  },  
  dnsLess: {
    isActive: {
      format: Boolean,
      default: false,
      doc: 'Activates routes /reg and /www. Builds service information on publicUrl.\n' + 
      'This requires to have built-in register and app-web-auth3.',
    },
    publicUrl: {
      format: String,
      default: undefined,
      doc: 'URL used to reach the service from the public internet.\n' +
      'In development, this can be http://localhost:PORT.\n' + 
      'In Production, as the service stands behind a NGINX reverse proxy, it should be different.'
    },
  },
  serviceInfoUrl: {
    format: String,
    default: undefined,
    doc: 'Can be either a URL such as https://something or a file path like file://path/to/my/file. ' +
         'If it is a file, you can provide relative or absolute paths (file:///). Relative paths ' +
         'will be resolved based on the root repository folder.'
  },
  service: {
    access: {
      format: String,
    },
    api: {
      format: String,
    },
    serial: {
      format: String,
    },
    register: {
      format: String,
    },
    name: {
      format: String,
    },
    home: {
      format: String,
    },
    support: {
      format: String,
    },
    terms: {
      format: String,
    },
    eventTypes: {
      format: String,
    },
    assets: {
      format: Object,
    },
  },
  env: {
    format: [ 'production', 'development', 'test' ],
    default: 'development',
    doc: 'The application environment.',
    env: 'NODE_ENV'
  },
  config: {
    format: String,
    default: '',
    doc: 'Optional path to a JSON configuration file. If empty, defaults to `config/{env}.json`.'
  },
  configOverrides: {
    format: String,
    default: '',
    doc: 'Optional path to an extra JSON configuration file. ' +
    'Typically used to define confidential settings (e.g. keys, secrets).'
  },
  printConfig: {
    format: Boolean,
    default: false,
    doc: 'If `true`, prints the configuration settings actually used to the console at load time'
  },
  domain: {
    format: String,
    default: 'pryv.li',
    doc: 'The fully qualified domain name associated to the Pryv.io platform',
  },
  reporting: {
    licenseName: {
      format: String,
      default: 'OVERRIDE ME',
      doc: 'Pryv.io licence'
    },
    role: {
      format: String,
      default: 'OVERRIDE ME',
      doc: 'Role of the component. i.e : core, reg-master, reg-slave, ...'
    },
    templateVersion: {
      format: String,
      default: '1.0.0',
      doc: 'Version number of the Pryv.io configuration, containing each role version'
    },
    hostname: {
      format: String,
      default: 'OVERRIDE ME',
      doc: 'Hostname of the machine.'
    },
    url : {
      format: String,
      default: 'https://reporting.pryv.com/reports',
      doc: 'Url to send the report. Should never be overriden except in the test-suite.'
    },
    optOut: {
      format: String,
      default: 'false',
      env: 'reporting_optOut',
      doc: 'Set to \'true\' to disable daily reporting to pryv.com' +
      'This parameter is meant to be set as an environment variable in the \'run-pryv\' script.',
    },
  },
  http: {
    ip: {
      format: 'ipaddress',
      default: '127.0.0.1'
    },
    port: {
      format: 'port',
      default: 3000, 
      arg: 'http-port'
    }
  },
  database: {
    authUser: {
      format: String,
      default: '',
      doc: 'If empty, no auth is used'
    },
    authPassword: {
      format: String,
      default: ''
    },
    host: {
      format: String,
      default: 'localhost'
    },
    port: {
      format: 'port',
      default: 27017
    },
    name: {
      format: String,
      default: 'pryv-node'
    }
  },
  eventFiles: {
    attachmentsDirPath: {
      format: String,
      default: path.join(__dirname, '../../../../../service-core-files/attachments')
    },
    previewsDirPath: {
      format: String,
      default: path.join(__dirname, '../../../../../service-core-files/previews')
    }
  },
  auth: {
    filesReadTokenSecret: {
      format: String,
      default: 'OVERRIDE ME',
      doc: 'The secret used to compute tokens for authentifying read accesses of event attachments'
    }
  },
  customExtensions: {
    defaultFolder: {
      format: String,
      default: path.join(__dirname, '../../../../custom-extensions'),
      doc: 'The folder in which custom extension modules are searched for by default. Unless ' +
      'defined by its specific setting (see other settings in `customExtensions`), each module ' +
      'is loaded from there by its default name (e.g. `customAuthStepFn.js`), or ignored if ' +
      'missing.'
    },
    customAuthStepFn: {
      format: String,
      default: '',
      doc: 'A Node module identifier (e.g. "/custom/auth/function.js") implementing a custom ' +
      'auth step (such as authenticating the caller id against an external service). ' +
      'The function is passed the method context, which it can alter, and a callback to be ' +
      'called with either no argument (success) or an error (failure). ' +
      'If this setting is not empty and the specified module cannot be loaded as a function, ' +
      'server startup will fail.'
    }
  },
  logs: {
    prefix: {
      format: String,
      default: '',
      doc: 'Will be prefixed to each logged message\'s context'
    },
    console: {
      active: {
        format: Boolean,
        default: true
      },
      level: {
        format: formats.logLevel,
        default: 'debug'
      },
      colorize: {
        format: Boolean,
        default: true
      }, 
      timestamp: {
        format: Boolean, 
        default: true, 
      }
    },
    file: {
      active: {
        format: Boolean,
        default: false
      },
      level: {
        format: formats.logLevel,
        default: 'error'
      },
      path: {
        format: String,
        default: 'server.log'
      },
      maxFileBytes: {
        format: 'nat',
        default: 4096
      },
      maxNbFiles: {
        format: 'nat',
        default: 20
      }
    },
    airbrake: {
      active: {
        format: Boolean,
        default: false
      },
      key: {
        format: String,
        default: '',
        doc: 'The Airbrake API key'
      },
      projectId: {
        format: String,
        default: '',
        doc: 'The Airbrake project id'
      }
    }
  },
  tcpMessaging: {
    enabled: {
      format: Boolean, 
      default: false, 
    },
    host: {
      format: String,
      default: 'localhost'
    },
    port: {
      format: 'port',
      default: 4000
    },
    pubConnectInsteadOfBind: {
      format: Boolean,
      default: false,
      doc: 'Used for tests to reverse the pub-sub init order'
    }
  },
  deprecated: {
    auth: {
      ssoIsWhoamiActivated: {
        format: Boolean,
        default: false,
        doc: 'Used to activate route `GET /auth/who-am-i` which has been deactivated ' +
          'by default because of a security vulnerability',
      }
    }
  }
};

/**
 * Loads configuration settings from (last takes precedence):
 *
 *   1. Defaults
 *   2. A file whose path is specified in the setting 'config', defaulting to 'config/{env}.json'
 *   3. An "overrides" file whose path is specified in the setting 'configOverrides'
 *   4. Environment variables
 *   5. Command-line arguments
 *
 * Note: possible output is printed to the console (logging is not yet setup at this point).
 *
 * @param configDefault An optional override default value for option `config`
 * @returns {Object} The loaded settings
 */
config.load = function (configDefault) {
  const instance = setup(configDefault);
  
  var settings = instance.get();

  if (settings.printConfig) {
    print('Configuration settings loaded', settings);
  }

  return settings;
};


async function setupWithServiceInfo(configDefault) {
  const instance = this.setup(configDefault);
  await ServiceInfo.addToConvict(instance);
  return instance;
}
config.setupWithServiceInfo = setupWithServiceInfo;

// For internal use only: loads convict instance, then validates and returns it. 
//
function setup(configDefault) {
  autoSetEnvAndArg(config.schema);

  var instance = convict(config.schema);

  var filePath = instance.get('config') ||
                 configDefault ||
                 'config/' + instance.get('env') + '.json';

  loadFile(filePath);

  var overridesFilePath = instance.get('configOverrides');
  if (overridesFilePath) {
    loadFile(overridesFilePath);
  }

  instance.validate();
  
  return instance; 

  function loadFile(fPath) {
    if (! fs.existsSync(fPath)) {
      console.error('Could not load config file ' + toString.path(fPath) + ''); // eslint-disable-line no-console
    } else {
      instance.loadFile(fPath);
    }
  }
}
config.setup = setup;

config.printSchemaAndExitIfNeeded = function () {
  process.argv.slice(2).forEach(function (arg) {
    if (arg === '--help') {
      autoSetEnvAndArg(this.schema);
      print('Available configuration settings', this.schema);
      process.exit(0);
    }
  }.bind(this));
};

function autoSetEnvAndArg(schema, context) {
  context = context || [];
  Object.keys(schema).forEach(function (key) {
    var value = schema[key],
        keyPath = context.concat(key);
    if (isSettingDefinition(value)) {
      value.env = value.env || getSettingEnvName(keyPath);
      value.arg = value.arg || getSettingArgName(keyPath);
    } else if (_.isObject(value)) {
      autoSetEnvAndArg(value, keyPath);
    }
  });
}

function isSettingDefinition(obj) {
  return obj.hasOwnProperty('default');
}

function getSettingEnvName(keyPath) {
  var envKeyPath = ['Pryv'].concat(keyPath);
  return envKeyPath.map(function (s) {
    return s.toUpperCase();
  }).join('_');
}

function getSettingArgName(keyPath) {
  return keyPath.join(':');
}

function print(title, data) {
  console.log(title + ':\n' + JSON.stringify(data, null, 2)); // eslint-disable-line no-console
}

