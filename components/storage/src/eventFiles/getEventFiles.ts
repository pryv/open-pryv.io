/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
import type { EventFiles as EventFilesT } from '../../../../storages/interfaces/fileStorage/EventFiles.ts';
const require = createRequire(import.meta.url);

const { getConfig } = require('@pryv/boiler');
const { EventFiles: EventLocalFiles } = require('storages/engines/filesystem/src/EventLocalFiles.ts');
const { validateEventFiles } = require('storages/interfaces/fileStorage/EventFiles.ts');

export { getEventFiles };

let eventFiles: EventFilesT | null = null;

async function getEventFiles () {
  if (eventFiles) return eventFiles;

  const settings = (await getConfig()).get('eventFiles');
  let newEventFiles: EventFilesT;
  if (settings.engine) {
    const EventEngine = require(settings.engine.modulePath);
    newEventFiles = new EventEngine(settings.engine);
  } else {
    newEventFiles = new EventLocalFiles();
  }
  eventFiles = newEventFiles;
  await newEventFiles.init();
  validateEventFiles(newEventFiles);
  return newEventFiles;
}
