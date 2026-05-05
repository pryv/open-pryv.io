/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfig } = require('@pryv/boiler');
const { EventFiles: EventLocalFiles } = require('storages/engines/filesystem/src/EventLocalFiles');
const { validateEventFiles } = require('storages/interfaces/fileStorage/EventFiles');

export { getEventFiles };

let eventFiles = null;

async function getEventFiles () {
  if (eventFiles) return eventFiles;

  const settings = (await getConfig()).get('eventFiles');
  if (settings.engine) {
    const EventEngine = require(settings.engine.modulePath);
    eventFiles = new EventEngine(settings.engine);
  } else {
    eventFiles = new EventLocalFiles();
  }
  await eventFiles.init();
  validateEventFiles(eventFiles);
  return eventFiles;
}
