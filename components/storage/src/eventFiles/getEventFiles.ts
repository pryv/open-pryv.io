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

  const config = await getConfig();
  const settings = config.get('eventFiles');
  const fileEngine = config.get('storages:file:engine') || 'filesystem';
  let newEventFiles: EventFilesT;
  if (settings.engine) {
    // Legacy escape hatch: `eventFiles.engine.modulePath` loads an
    // arbitrary EventFiles class. Predates the storages engine registry;
    // takes precedence for backwards compatibility.
    const EventEngine = require(settings.engine.modulePath);
    newEventFiles = new EventEngine(settings.engine);
  } else if (fileEngine !== 'filesystem') {
    // Non-default fileStorage engine (e.g. `s3`) — resolve through the
    // storages plugin registry. The barrel's init() has already run
    // pluginLoader.init() + the engine's init(config, getLogger, …) by
    // the time any consumer requests event files.
    const { pluginLoader } = require('storages');
    const engineModule = pluginLoader.getEngineModule(fileEngine);
    newEventFiles = await engineModule.createFileStorage();
  } else {
    newEventFiles = new EventLocalFiles();
  }
  eventFiles = newEventFiles;
  await newEventFiles.init();
  validateEventFiles(newEventFiles);
  return newEventFiles;
}
