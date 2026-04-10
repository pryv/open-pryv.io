/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification of methods data for profile settings.
 */

const helpers = require('./helpers');
const object = helpers.object;
const string = helpers.string;

const profileData = object({ /* no constraints */ });

module.exports = {

  get: {
    params: object({
      // in path for HTTP requests
      id: string()
    }, {
      required: ['id']
    }),
    result: object({
      profile: profileData
    })
  },

  update: {
    params: object({
      // in path for HTTP requests
      id: string(),
      // = body of HTTP requests
      update: profileData
    }, {
      required: ['id', 'update']
    }),
    result: object({
      profile: profileData
    }, {
      required: ['profile']
    })
  }

};
