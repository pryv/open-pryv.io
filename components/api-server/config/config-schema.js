/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * 
 * SPDX-License-Identifier: BSD-3-Clause
 * 
 */
const path = require('path');


module.exports = config = {};

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
      default: true,
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
    },
    connectTimeoutMS: {
      default: 60000,
      env: 'CONNECT_TIMOUT_MS'
    },
    socketTimeoutMS: {
      default: 60000,
      env: 'SOCKET_TIMOUT_MS'
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
  updates: {
     ignoreProtectedFields: {
      format: Boolean,
      default: false,
      doc: 'To be written'
    }
  }
};
