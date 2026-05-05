/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * JSON Schema specification of methods data for auth.
 */
const { ErrorIds } = require('errors/src/ErrorIds');
const { ErrorMessages } = require('errors/src/ErrorMessages');
const accountStreams = require('business/src/system-streams');
const helpers = require('./helpers');
const object = helpers.object;
const string = helpers.string;
const registrationSchema = {
  params: object({
    username: helpers.username,
    password: string({
      minLength: 6,
      maxLength: 100
    }),
    email: helpers.email,
    appId: string({
      minLength: 6,
      maxLength: 99
    }),
    invitationToken: string(),
    referer: string({
      nullable: true,
      minLength: 1,
      maxLength: 99
    }),
    language: helpers.language
  }, {
    required: ['password'],
    messages: {
      appId: {
        MIN_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidAppId],
          code: ErrorIds.InvalidAppId
        },
        MAX_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidAppId],
          code: ErrorIds.InvalidAppId
        },
        INVALID_TYPE: {
          message: ErrorMessages[ErrorIds.InvalidAppId],
          code: ErrorIds.InvalidAppId
        },
        OBJECT_MISSING_REQUIRED_PROPERTY: {
          message: ErrorMessages[ErrorIds.MissingRequiredField] + ': appId',
          code: ErrorIds.InvalidAppId
        }
      },
      username: {
        PATTERN: {
          message: ErrorMessages[ErrorIds.InvalidUsername],
          code: ErrorIds.InvalidUsername
        },
        OBJECT_MISSING_REQUIRED_PROPERTY: {
          message: ErrorMessages[ErrorIds.UsernameRequired],
          code: ErrorIds.UsernameRequired
        }
      },
      password: {
        MIN_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidPassword],
          code: ErrorIds.InvalidPassword
        },
        MAX_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidPassword],
          code: ErrorIds.InvalidPassword
        },
        INVALID_TYPE: {
          message: ErrorMessages[ErrorIds.InvalidPassword],
          code: ErrorIds.InvalidPassword
        },
        OBJECT_MISSING_REQUIRED_PROPERTY: {
          message: ErrorMessages[ErrorIds.PasswordRequired],
          code: ErrorIds.PasswordRequired
        }
      },
      email: {
        INVALID_TYPE: {
          message: ErrorMessages[ErrorIds.InvalidEmail],
          code: ErrorIds.InvalidEmail
        },
        OBJECT_MISSING_REQUIRED_PROPERTY: {
          message: ErrorMessages[ErrorIds.EmailRequired],
          code: ErrorIds.EmailRequired
        }
      },
      invitationToken: {
        INVALID_TYPE: {
          message: ErrorMessages[ErrorIds.InvalidInvitationToken],
          code: ErrorIds.InvalidInvitationToken
        }
      },
      referer: {
        MIN_LENGTH: {
          message: ErrorMessages[ErrorIds.Invalidreferer],
          code: ErrorIds.Invalidreferer
        },
        MAX_LENGTH: {
          message: ErrorMessages[ErrorIds.Invalidreferer],
          code: ErrorIds.Invalidreferer
        },
        INVALID_TYPE: {
          message: ErrorMessages[ErrorIds.Invalidreferer],
          code: ErrorIds.Invalidreferer
        }
      },
      language: {
        MAX_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidLanguage],
          code: ErrorIds.InvalidLanguage
        },
        MIN_LENGTH: {
          message: ErrorMessages[ErrorIds.InvalidLanguage],
          code: ErrorIds.InvalidLanguage
        }
      },
      additionalProperties: true
    }
  }),
  result: object({
    username: string(),
    apiEndpoint: string()
  }, {
    required: ['username'],
    additionalProperties: true
  })
};
// extend registration settings with settings from the accountStreams
registrationSchema.params = loadCustomValidationSettings(registrationSchema.params);
module.exports = {
  login: {
    params: object({
      username: string(),
      password: string(),
      appId: string(),
      origin: string()
    }, {
      required: ['username', 'password', 'appId'],
      additionalProperties: false
    }),
    result: object({
      token: string(),
      apiEndpoint: string()
    }, {
      required: ['token'],
      additionalProperties: false
    })
  },
  logout: {
    params: object({})
  },
  register: registrationSchema,
  usernameCheck: {
    params: object({
      username: helpers.username
    }, {
      required: ['username'],
      messages: {
        username: {
          PATTERN: {
            message: ErrorMessages[ErrorIds.InvalidUsername],
            code: ErrorIds.InvalidUsername
          },
          OBJECT_MISSING_REQUIRED_PROPERTY: {
            message: ErrorMessages[ErrorIds.UsernameRequired],
            code: ErrorIds.UsernameRequired
          }
        }
      },
      additionalProperties: false
    })
  },
  emailCheck: {
    params: object({
      email: helpers.email
    }, {
      required: ['email'],
      messages: {
        email: {
          PATTERN: {
            message: ErrorMessages[ErrorIds.InvalidEmail],
            code: ErrorIds.InvalidEmail
          },
          OBJECT_MISSING_REQUIRED_PROPERTY: {
            message: ErrorMessages[ErrorIds.EmailRequired],
            code: ErrorIds.EmailRequired
          }
        }
      },
      additionalProperties: false
    })
  }
};
/**
 * Append validation of custom system streams for registration method
 * @returns {any}
 */
function loadCustomValidationSettings (validationSchema) {
  // iterate account stream settings and APPEND validation with relevant properties
  // etc additional required fields or regex validation
  const accountStreamsSettings = accountStreams.accountMap;
  for (const [streamIdWithPrefix, systemStream] of Object.entries(accountStreamsSettings) as Array<[string, any]>) {
    // if streamIdWithPrefix is set as required - add required validation
    const streamId = accountStreams.toFieldName(streamIdWithPrefix);
    if (systemStream.isRequiredInValidation &&
            !validationSchema.required.includes(streamIdWithPrefix)) {
      validationSchema.required.push(streamId);
      // the error message of required property by z-schema is still obscure
    }
    // if accountStream hasfield has type validation - add regex type rule
    // etc : '^(series:)?[a-z0-9-]+/[a-z0-9-]+$'
    if (validationSchema.properties[streamId] == null) {
      if (systemStream.regexValidation != null) {
        validationSchema.properties[streamId] = string({
          pattern: systemStream.regexValidation
        });
      } else {
        validationSchema.properties[streamId] = string();
      }
    }
    // if there is an error message and code specified, set those too
    if (systemStream.regexError != null &&
            validationSchema.messages[streamId] == null) {
      validationSchema.messages[streamId] = {
        PATTERN: systemStream.regexError
      };
    }
  }
  return validationSchema;
}
