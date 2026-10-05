/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const morgan = require('morgan');
const { getLogger } = require('@pryv/boiler');
const { redactUrl } = require('utils/src/redactUrl.ts');

// morgan's `combined` format, with the URL's `auth` query value redacted: preview
// and attachment links carry the access token there.
morgan.token('redacted-url', (req: { originalUrl?: string, url?: string }) => redactUrl(req.originalUrl || req.url));
const COMBINED_REDACTED = ':remote-addr - :remote-user [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';

export default function (express: unknown) {
  const logger = getLogger('request-trace');
  const morganLoggerStreamWrite = (msg: string) => logger.info(msg);
  return morgan(COMBINED_REDACTED, {
    stream: {
      write: morganLoggerStreamWrite
    }
  });
};
