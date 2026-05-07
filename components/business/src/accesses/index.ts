/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __ex_AccessLogic = require('./AccessLogic.ts').default;
export { __ex_AccessLogic as AccessLogic };

type Access = {
  id: string;
  token: string;
  type: string;
  name: string;
  deviceName: string | undefined | null;
  permissions: Array<Permission>;
  lastUsed: number | undefined | null;
  expireAfter: number | undefined | null;
  expires: number | undefined | null;
  deleted: number | undefined | null;
  clientData: {} | undefined | null;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
};
type Permission = {
  streamId: string;
  level: string;
  feature: string | undefined | null;
  setting: string | undefined | null;
};
