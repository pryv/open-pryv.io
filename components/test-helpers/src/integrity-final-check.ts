/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";

/**
 * Load all events and check if the "integrity" is OK.
 * Engine-agnostic: works with both MongoDB and PostgreSQL via async iterators.
 */
const { getStorageLayer } = require('storage');
const { integrity } = require('business');

let storageLayer;
async function getStorage () {
  if (!storageLayer) storageLayer = await getStorageLayer();
  return storageLayer;
}

async function events () {
  if (!integrity.events.isActive) return;
  const sl = await getStorage();
  const erroneousEvents = [];
  let andNMore = 0;
  for await (const event of sl.iterateAllEvents()) {
    let originalId = null;
    if (event.headId != null) {
      if (!event.integrity) continue; // ignore missing integrity on history
      originalId = event.id;
      event.id = event.headId;
      delete event.headId;
    }

    const errors = [];

    if (typeof event.duration !== 'undefined') {
      errors.push('unexpected duration prop');
    }

    if (event.integrity === undefined) {
      errors.push('event has no integrity property');
    } else {
      const i = integrity.events.compute(event).integrity;
      if (i !== event.integrity) {
        errors.push('expected integrity: ' + i);
      }
    }

    if (errors.length !== 0) {
      if (erroneousEvents.length < 3) {
        if (originalId != null) { event._originalId = originalId; }
        erroneousEvents.push({ event, errors });
      } else {
        andNMore++;
      }
    }
  }
  if (erroneousEvents.length > 0) {
    if (andNMore > 0) {
      erroneousEvents.push('... And ' + andNMore + ' More');
    }
    throw new Error('Integrity not respected for ' + JSON.stringify(erroneousEvents, null, 2));
  }
}

async function accesses () {
  if (!integrity.accesses.isActive) return;
  const sl = await getStorage();
  const erroneousAccess = [];
  let andNMore = 0;
  for await (const access of sl.accesses.iterateAll()) {
    const errors = [];

    if (access.integrity === undefined) {
      errors.push('access has no integrity property');
    } else {
      const i = integrity.accesses.compute(access).integrity;
      if (i !== access.integrity) {
        errors.push('expected integrity: ' + i);
      }
    }

    if (errors.length !== 0) {
      if (erroneousAccess.length < 3) {
        erroneousAccess.push({ access, errors });
      } else {
        andNMore++;
      }
    }
  }
  if (erroneousAccess.length > 0) {
    if (andNMore > 0) {
      erroneousAccess.push('... And ' + andNMore + ' More');
    }
    throw new Error('Integrity not respected for ' + JSON.stringify(erroneousAccess, null, 2));
  }
}

async function all () {
  await events();
  await accesses();
}

module.exports = { all };
