/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification for events.
 */

const helpers = require('./helpers.ts');
const object = helpers.object;
const string = helpers.string;

export default function () {
  const schema = object({
    serial: string(),
    api: string(),
    access: string(),
    register: string(),
    name: string(),
    home: string(),
    support: string(),
    terms: string(),
    eventTypes: string(),
    assets: object({}),
    features: object({}),
    // Platform version — SDKs (lib-js, app-web-auth3) read this to pick
    // the direct-core `/users` registration endpoint (>=1.6.0). Without
    // it they fall back to the legacy `/reg/user` path that round-robins
    // through reg.{domain} and breaks cross-core registration on
    // multi-core deployments.
    version: string()
  }, {
    required: ['serial', 'api', 'access', 'register', 'name', 'home', 'support', 'terms', 'eventTypes'],
    additionalProperties: false
  });

  return schema;
};
