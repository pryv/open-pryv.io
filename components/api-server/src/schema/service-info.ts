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
const array = helpers.array;

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
    version: string(),
    // Optional list of adapter base URLs. Adapters are transient converters
    // between Pryv and an external standard (e.g. iCalendar). Each URL serves
    // the adapter's web UI and a `manifest.json` under it; clients fetch
    // `<url>/manifest.json` for the adapter's name, type, version and
    // capabilities. `{username}` templating is allowed, as for `api`.
    adapters: array(string(), { nullable: true })
  }, {
    required: ['serial', 'api', 'access', 'register', 'name', 'home', 'support', 'terms', 'eventTypes'],
    additionalProperties: false
  });

  return schema;
};
