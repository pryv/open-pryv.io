#!/usr/bin/env node
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Seed script — creates test user accounts with realistic data.
 *
 * Usage:
 *   node datasets/seed.js --target http://127.0.0.1:3000 --users 5 --events 50000 --profile manual
 *
 * Outputs: datasets/seed-result.json
 */

import fs from 'node:fs';
import { parseConfig } from '../lib/config.js';
import { snapshotStorageSizes, storageDelta, formatStorageSizes } from '../lib/storage-size.js';

const config = parseConfig(process.argv.slice(2));
const TARGET = config.target.replace(/\/$/, '');
const NUM_USERS = config.users;
const EVENTS_PER_USER = config.events;
const PROFILE = config.profile;
const ADMIN_KEY = config.adminKey;

// ─── Stream definitions ────────────────────────────────────────────

function manualStreams () {
  // Based on perki.pryv.me: ~100 streams, mostly flat, a few nested trees up to 4 levels
  return [
    // Flat top-level streams (the bulk)
    { id: 'diary', name: 'Journal' },
    { id: 'body', name: 'Body' },
    { id: 'weight', name: 'Weight' },
    { id: 'blood-pressure', name: 'Blood Pressure' },
    { id: 'glycemia', name: 'Glycemia' },
    { id: 'heart', name: 'Heart' },
    { id: 'cardio', name: 'Cardio' },
    { id: 'mood', name: 'Mood' },
    { id: 'stress', name: 'Stress' },
    { id: 'lifestyle', name: 'Lifestyle' },
    { id: 'medication', name: 'Medication' },
    { id: 'nutrition-flat', name: 'Nutrition notes' },
    { id: 'position', name: 'Geolocation' },
    { id: 'diagnosis', name: 'Diagnosis' },
    { id: 'diagnostics', name: 'Diagnostics' },
    { id: 'genetics', name: 'Genetics' },
    { id: 'genomics', name: 'Genomics' },
    { id: 'insurance-advices', name: 'Insurance Advices' },
    { id: 'iot', name: 'IoT Data' },
    { id: 'gait', name: 'Gait Data' },
    { id: 'sensor', name: 'Sensor' },
    { id: 'settings', name: 'Settings' },
    { id: 'profile', name: 'Profile' },
    { id: 'network', name: 'Network' },
    { id: 'work', name: 'Work' },
    { id: 'agenda', name: 'Agenda' },
    { id: 'searches', name: 'Searches' },
    { id: 'steps', name: 'Steps' },
    { id: 'allergens', name: 'Allergens' },
    { id: 'biometrics', name: 'Biometrics' },
    { id: 'location', name: 'Location' },
    { id: 'signin', name: 'Signin Log' },
    { id: 'outcomes', name: 'Outcomes' },
    { id: 'process', name: 'Process' },
    { id: 'result', name: 'Result' },
    { id: 'sadness', name: 'Sadness' },
    { id: 'recommendation', name: 'Recommendation' },

    // Nested: Activity tree (2 levels)
    { id: 'activity', name: 'Activity' },
    { id: 'activity-aerobic', name: 'Aerobic activity', parentId: 'activity' },
    { id: 'activity-flexibility', name: 'Flexibility', parentId: 'activity' },
    { id: 'activity-strength', name: 'Strength training', parentId: 'activity' },

    // Nested: Health tree (4 levels deep)
    { id: 'health', name: 'Health' },
    { id: 'health-data', name: 'Data', parentId: 'health' },
    { id: 'health-data-bp', name: 'Blood pressure', parentId: 'health-data' },
    { id: 'health-data-bp-high', name: 'High pressure', parentId: 'health-data-bp' },
    { id: 'health-data-bp-low', name: 'Low pressure', parentId: 'health-data-bp' },
    { id: 'health-data-bp-device', name: 'Device Training', parentId: 'health-data-bp' },
    { id: 'health-data-glycemia', name: 'Glycemia', parentId: 'health-data' },
    { id: 'health-data-heartrate', name: 'Heart rate', parentId: 'health-data' },
    { id: 'health-checkups', name: 'Medical checkups', parentId: 'health' },
    { id: 'health-checkups-gp', name: 'GP', parentId: 'health-checkups' },
    { id: 'health-checkups-eye', name: 'Eye doctor', parentId: 'health-checkups' },
    { id: 'health-checkups-diet', name: 'Dietitian', parentId: 'health-checkups' },

    // Nested: Nutrition tree (4 levels deep)
    { id: 'nutrition', name: 'Nutrition' },
    { id: 'nutrition-plan', name: 'Nutrition plan', parentId: 'nutrition' },
    { id: 'nutrition-supplements', name: 'Supplements', parentId: 'nutrition' },
    { id: 'nutrition-supplements-boost', name: 'Boost', parentId: 'nutrition-supplements' },
    { id: 'nutrition-calories', name: 'Total calories', parentId: 'nutrition' },
    { id: 'nutrition-calories-proteins', name: 'Proteins', parentId: 'nutrition-calories' },
    { id: 'nutrition-calories-vitamins', name: 'Vitamins', parentId: 'nutrition-calories' },
    { id: 'nutrition-calories-vitamins-c', name: 'Vitamin C', parentId: 'nutrition-calories-vitamins' },
    { id: 'nutrition-calories-vitamins-d', name: 'Vitamin D', parentId: 'nutrition-calories-vitamins' },

    // Nested: Diary tree (3 levels)
    { id: 'diary-diabetes', name: 'Diabetes management', parentId: 'diary' },
    { id: 'diary-diabetes-feelings', name: 'Feelings', parentId: 'diary-diabetes' },

    // Nested: Stress tree (2 levels)
    { id: 'stress-level', name: 'Stress level', parentId: 'stress' },
    { id: 'stress-level-mood', name: 'Feelings/mood', parentId: 'stress-level' },

    // Baby tree (2 levels)
    { id: 'baby', name: 'Baby' },
    { id: 'baby-body', name: 'Baby Body', parentId: 'baby' }
  ];
}

function iotStreams () {
  // Based on demo.datasafe.dev/miratest: ~50 streams, structured hierarchy
  return [
    { id: 'applications', name: 'Applications' },
    { id: 'app-client-dr-form', name: 'HDS Patient app PoC', parentId: 'applications' },

    { id: 'body', name: 'Body' },
    { id: 'body-weight', name: 'Body Weight', parentId: 'body' },
    { id: 'body-urine', name: 'Urine', parentId: 'body' },
    { id: 'body-urine-hormones', name: 'Urine Hormones', parentId: 'body-urine' },
    { id: 'body-urine-hormones-e3g', name: 'E3G', parentId: 'body-urine-hormones' },
    { id: 'body-urine-hormones-fsh', name: 'FSH', parentId: 'body-urine-hormones' },
    { id: 'body-urine-hormones-lh', name: 'LH', parentId: 'body-urine-hormones' },
    { id: 'body-urine-hormones-pdg', name: 'PdG', parentId: 'body-urine-hormones' },
    { id: 'body-urine-hormones-hcg', name: 'hCG', parentId: 'body-urine-hormones' },
    { id: 'body-vulva', name: 'Vulva', parentId: 'body' },
    { id: 'body-vulva-bleeding', name: 'Vulva Bleeding', parentId: 'body-vulva' },
    { id: 'body-vulva-bleeding-brown', name: 'Brown/dark coloration', parentId: 'body-vulva-bleeding' },

    { id: 'chats', name: 'Chats' },
    { id: 'chat-drandy', name: 'Chat drandy', parentId: 'chats' },
    { id: 'chat-drandy-in', name: 'Chat drandy In', parentId: 'chat-drandy' },

    { id: 'fertility', name: 'Fertility' },
    { id: 'fertility-cycles', name: 'Cycles', parentId: 'fertility' },
    { id: 'fertility-cycles-fertile', name: 'Fertile Window', parentId: 'fertility-cycles' },
    { id: 'fertility-cycles-start', name: 'New Cycle', parentId: 'fertility-cycles' },
    { id: 'fertility-cycles-ovulation', name: 'Ovulation Day', parentId: 'fertility-cycles' },
    { id: 'fertility-cycles-period', name: 'Period', parentId: 'fertility-cycles' },
    { id: 'fertility-test-opk', name: 'Ovulation Test (OPK)', parentId: 'fertility' },
    { id: 'fertility-test-pregnancy', name: 'Pregnancy Test', parentId: 'fertility' },
    { id: 'fertility-sexual-activity', name: 'Sexual Activity', parentId: 'fertility' },

    { id: 'medication', name: 'Medication' },
    { id: 'medication-intake', name: 'Intake', parentId: 'medication' },

    { id: 'bridge-mira', name: 'Mira Bridge' },
    { id: 'bridge-mira-raw', name: 'Data from Mira', parentId: 'bridge-mira' },
    { id: 'bridge-mira-raw-converted', name: 'Converted Data', parentId: 'bridge-mira-raw' },
    { id: 'bridge-mira-raw-error', name: 'Errors', parentId: 'bridge-mira-raw' },
    { id: 'bridge-mira-raw-new', name: 'New Data', parentId: 'bridge-mira-raw' },
    { id: 'bridge-mira-app', name: 'Mira App', parentId: 'bridge-mira' },
    { id: 'bridge-mira-app-notes', name: 'Notes', parentId: 'bridge-mira-app' },

    { id: 'profile', name: 'Profile' },
    { id: 'profile-name', name: 'Name', parentId: 'profile' },

    { id: 'symptom', name: 'Symptoms' },
    { id: 'symptom-gastrointestinal', name: 'Gastrointestinal', parentId: 'symptom' },
    { id: 'symptom-gastrointestinal-cramps', name: 'Cramps', parentId: 'symptom-gastrointestinal' },
    { id: 'symptom-gastrointestinal-cravings', name: 'Cravings', parentId: 'symptom-gastrointestinal' },
    { id: 'symptom-gastrointestinal-gas', name: 'Gas', parentId: 'symptom-gastrointestinal' },
    { id: 'symptom-gastrointestinal-nausea', name: 'Nausea', parentId: 'symptom-gastrointestinal' },
    { id: 'symptom-pain', name: 'Pain', parentId: 'symptom' },
    { id: 'symptom-pain-headache', name: 'Headache', parentId: 'symptom-pain' },
    { id: 'symptom-pain-migraine', name: 'Migraine', parentId: 'symptom-pain' }
  ];
}

// ─── Event generators ──────────────────────────────────────────────

function manualEventGenerator (streams) {
  const leafStreams = streams.filter(s => !streams.some(c => c.parentId === s.id));
  const leafIds = leafStreams.map(s => s.id);

  // weighted distribution: position and heartrate heavy, rest lighter
  const heavyStreams = ['position', 'health-data-heartrate', 'health-data-bp-high', 'health-data-bp-low', 'steps'];
  const mediumStreams = ['diary', 'nutrition-calories', 'body', 'mood', 'stress'];

  const typesByStream = {
    position: { type: 'position/wgs84', gen: () => ({ latitude: 46.5 + Math.random() * 0.05, longitude: 6.55 + Math.random() * 0.05 }) },
    'health-data-heartrate': { type: 'frequency/bpm', gen: () => 60 + Math.floor(Math.random() * 60) },
    'health-data-bp-high': { type: 'pressure/mmhg', gen: () => 110 + Math.floor(Math.random() * 40) },
    'health-data-bp-low': { type: 'pressure/mmhg', gen: () => 60 + Math.floor(Math.random() * 30) },
    steps: { type: 'count/steps', gen: () => 1000 + Math.floor(Math.random() * 15000) },
    'nutrition-calories': { type: 'energy/cal', gen: () => 100 + Math.floor(Math.random() * 2500) },
    weight: { type: 'mass/kg', gen: () => +(60 + Math.random() * 40).toFixed(1) },
    'baby-body': { type: 'mass/kg', gen: () => +(3 + Math.random() * 15).toFixed(1) },
    glycemia: { type: 'density/mmol-l', gen: () => +(3 + Math.random() * 8).toFixed(1) }
  };

  return function generateEvent (idx, totalEvents) {
    let streamId;
    const roll = Math.random() * 100;

    if (roll < 40) {
      // 40% heavy streams
      streamId = heavyStreams[idx % heavyStreams.length];
    } else if (roll < 60) {
      // 20% medium streams
      streamId = mediumStreams[idx % mediumStreams.length];
    } else {
      // 40% spread across all leaves
      streamId = leafIds[idx % leafIds.length];
    }

    // ensure streamId exists
    if (!leafIds.includes(streamId) && !streams.some(s => s.id === streamId)) {
      streamId = leafIds[idx % leafIds.length];
    }

    const spec = typesByStream[streamId];
    if (spec) {
      return {
        type: spec.type,
        streamIds: [streamId],
        content: spec.gen(),
        time: baseTime(idx, totalEvents)
      };
    }

    // default: note/txt
    return {
      type: 'note/txt',
      streamIds: [streamId],
      content: `Note entry ${idx}`,
      time: baseTime(idx, totalEvents)
    };
  };
}

function iotEventGenerator (streams) {
  // 95% of events in 5 dense streams (hormone measurements)
  const denseStreams = [
    'body-urine-hormones-e3g',
    'body-urine-hormones-fsh',
    'body-urine-hormones-lh',
    'body-urine-hormones-pdg',
    'bridge-mira-raw-converted'
  ];
  const sparseStreams = streams
    .filter(s => !streams.some(c => c.parentId === s.id))
    .filter(s => !denseStreams.includes(s.id))
    .map(s => s.id);

  const concentrationTypes = {
    'body-urine-hormones-e3g': 'concentration/ug-l',
    'body-urine-hormones-fsh': 'concentration/iu-l',
    'body-urine-hormones-lh': 'concentration/mg-l',
    'body-urine-hormones-pdg': 'concentration/iu-l',
    'body-urine-hormones-hcg': 'concentration/iu-l'
  };

  return function generateEvent (idx, totalEvents) {
    const roll = Math.random() * 100;

    if (roll < 95) {
      // 95% dense IoT data
      const streamId = denseStreams[idx % denseStreams.length];

      if (streamId === 'bridge-mira-raw-converted') {
        return {
          type: 'note/txt',
          streamIds: [streamId],
          content: JSON.stringify({ lh: (Math.random() * 20).toFixed(1), e3g: (Math.random() * 200).toFixed(1) }),
          time: baseTime(idx, totalEvents)
        };
      }

      return {
        type: concentrationTypes[streamId] || 'concentration/iu-l',
        streamIds: [streamId],
        content: +(Math.random() * 50).toFixed(1),
        time: baseTime(idx, totalEvents)
      };
    }

    // 5% sparse
    const streamId = sparseStreams[idx % Math.max(sparseStreams.length, 1)] || 'medication-intake';
    return {
      type: 'activity/plain',
      streamIds: [streamId],
      content: null,
      time: baseTime(idx, totalEvents)
    };
  };
}

// spread events over ~1 year
function baseTime (idx, totalEvents) {
  const now = Date.now() / 1000;
  const oneYear = 365 * 24 * 3600;
  return now - oneYear + (idx / totalEvents) * oneYear;
}

// ─── API helpers ───────────────────────────────────────────────────

async function apiCall (method, path, body, token) {
  const origin = new URL(TARGET).origin;
  const opts = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: token || '',
      origin
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(TARGET + path, opts);
  const data = await res.json();
  if (!res.ok && data.error) {
    throw new Error(`${method} ${path}: ${data.error.message || res.status}`);
  }
  return data;
}

async function systemCall (method, path, body) {
  return apiCall(method, path, body, ADMIN_KEY);
}

async function createUser (username) {
  // Create user via registration endpoint (POST /users)
  const res = await apiCall('POST', '/users', {
    username,
    password: 'benchmark-pass-1234',
    email: `${username}@benchmark.local`,
    language: 'en',
    appId: 'pryv-benchmark'
  });
  return res;
}

async function deleteUser (username, personalToken) {
  // Delete user via auth route (DELETE /users/:username with personal token)
  try {
    await apiCall('DELETE', `/users/${username}`, null, personalToken);
    console.log(`  Deleted user: ${username}`);
  } catch {
    // Fallback: try with admin key via system route
    try {
      await systemCall('DELETE', `/system/users/${username}`);
      console.log(`  Deleted user registration: ${username}`);
    } catch (err2) {
      console.error(`  Failed to delete ${username}: ${err2.message}`);
    }
  }
}

async function login (username) {
  const res = await apiCall('POST', `/${username}/auth/login`, {
    username,
    password: 'benchmark-pass-1234',
    appId: 'pryv-benchmark'
  });
  return res.token;
}

// ─── Clean ─────────────────────────────────────────────────────────

async function cleanSeededUsers () {
  const seedPath = new URL('seed-result.json', import.meta.url).pathname;
  if (!fs.existsSync(seedPath)) {
    console.error('No seed-result.json found — nothing to clean.');
    process.exit(1);
  }

  const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  console.log(`Cleaning ${seedData.users.length} benchmark users from ${seedData.target}...`);

  for (const user of seedData.users) {
    await deleteUser(user.username, user.masterToken);
  }

  fs.unlinkSync(seedPath);
  console.log('\nCleanup complete. seed-result.json removed.');
}

// ─── Main ──────────────────────────────────────────────────────────

async function main () {
  if (config.clean) {
    await cleanSeededUsers();
    return;
  }

  console.log(`Seeding ${NUM_USERS} users with ${EVENTS_PER_USER} events each (profile: ${PROFILE})`);
  console.log(`Target: ${TARGET}`);

  // capture baseline storage snapshot (empty DB after fresh start)
  const storageBaseline = snapshotStorageSizes();
  console.log('Storage baseline captured');

  const streams = PROFILE === 'iot' ? iotStreams() : manualStreams();
  const eventGen = PROFILE === 'iot' ? iotEventGenerator(streams) : manualEventGenerator(streams);

  // identify parent streams (streams that have children)
  const parentStreamIds = [...new Set(streams.filter(s => s.parentId).map(s => s.parentId))];
  // leaf streams
  const leafStreamIds = streams.filter(s => !parentStreamIds.includes(s.id)).map(s => s.id);

  const seedResult = {
    target: TARGET,
    profile: PROFILE,
    eventsPerUser: EVENTS_PER_USER,
    seedTime: Date.now() / 1000,
    users: []
  };

  for (let u = 0; u < NUM_USERS; u++) {
    const username = `bench-${PROFILE}-${u}-${Date.now().toString(36)}`;
    console.log(`\n[${u + 1}/${NUM_USERS}] Creating user: ${username}`);

    try {
      await createUser(username);
    } catch (err) {
      console.error(`  Failed to create user: ${err.message}`);
      continue;
    }

    // login to get personal token (master)
    let masterToken;
    try {
      masterToken = await login(username);
    } catch (err) {
      console.error(`  Failed to login: ${err.message}`);
      continue;
    }

    console.log('  Master token obtained');

    // create streams
    console.log(`  Creating ${streams.length} streams...`);
    // create in order (parents before children)
    const created = new Set();
    const ordered = [];
    const remaining = [...streams];
    while (remaining.length > 0) {
      const before = remaining.length;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const s = remaining[i];
        if (!s.parentId || created.has(s.parentId)) {
          ordered.push(s);
          created.add(s.id);
          remaining.splice(i, 1);
        }
      }
      if (remaining.length === before) {
        // circular or missing parent — push remaining
        ordered.push(...remaining);
        break;
      }
    }

    for (const stream of ordered) {
      try {
        const data = { id: stream.id, name: stream.name };
        if (stream.parentId) data.parentId = stream.parentId;
        await apiCall('POST', `/${username}/streams`, data, masterToken);
      } catch (err) {
        // stream might already exist
        if (!err.message.includes('already')) {
          console.error(`  Stream ${stream.id}: ${err.message}`);
        }
      }
    }

    // create restricted access (10 streams)
    const restrictedStreams = leafStreamIds.slice(0, 10);
    let restrictedToken;
    try {
      const accessRes = await apiCall('POST', `/${username}/accesses`, {
        type: 'shared',
        name: 'benchmark-restricted',
        permissions: restrictedStreams.map(s => ({ streamId: s, level: 'contribute' }))
      }, masterToken);
      restrictedToken = accessRes.access?.token || null;
    } catch (err) {
      console.error(`  Failed to create restricted access: ${err.message}`);
      restrictedToken = masterToken; // fallback
    }

    // create events in batches
    console.log(`  Creating ${EVENTS_PER_USER} events...`);
    const BATCH_SIZE = 100;
    let createdCount = 0;
    let errors = 0;

    for (let i = 0; i < EVENTS_PER_USER; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, EVENTS_PER_USER);
      const promises = [];
      for (let j = i; j < batchEnd; j++) {
        const event = eventGen(j, EVENTS_PER_USER);
        promises.push(
          apiCall('POST', `/${username}/events`, event, masterToken)
            .then(() => { createdCount++; })
            .catch(() => { errors++; })
        );
      }
      await Promise.all(promises);

      if ((i + BATCH_SIZE) % 5000 === 0 || batchEnd === EVENTS_PER_USER) {
        console.log(`    ${createdCount}/${EVENTS_PER_USER} events created (${errors} errors)`);
      }
    }

    // create series events for HF benchmarks
    const seriesEventIds = [];
    const seriesTypes = ['series:mass/kg', 'series:temperature/c'];
    for (const seriesType of seriesTypes) {
      try {
        const seriesStreamId = leafStreamIds[0];
        const res = await apiCall('POST', `/${username}/events`, {
          type: seriesType,
          streamIds: [seriesStreamId]
        }, masterToken);
        if (res.event?.id) {
          seriesEventIds.push(res.event.id);
        }
      } catch {
        // HFS/InfluxDB may not be available — skip silently
      }
    }
    // seed initial data points into series (for read benchmarks)
    const hfsTarget = config.hfsTarget.replace(/\/$/, '');
    const SEED_POINTS = 100000;
    const HFS_BATCH = 5000; // points per POST (keep requests reasonable)
    for (const eventId of seriesEventIds) {
      const baseTime = Math.floor(Date.now() / 1000) - SEED_POINTS;
      let seeded = 0;
      for (let offset = 0; offset < SEED_POINTS; offset += HFS_BATCH) {
        const batchSize = Math.min(HFS_BATCH, SEED_POINTS - offset);
        const points = [];
        for (let i = 0; i < batchSize; i++) {
          points.push([baseTime + offset + i, +(Math.random() * 100).toFixed(2)]);
        }
        try {
          const hfsOpts = {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: masterToken },
            body: JSON.stringify({ format: 'flatJSON', fields: ['deltaTime', 'value'], points })
          };
          const hfsRes = await fetch(`${hfsTarget}/${username}/events/${eventId}/series`, hfsOpts);
          if (hfsRes.ok) {
            seeded += batchSize;
          } else {
            const hfsBody = await hfsRes.json();
            console.error(`  HFS seed error: ${hfsBody?.error?.message || hfsRes.status}`);
            break;
          }
        } catch {
          // HFS not available — skip remaining
          break;
        }
      }
      if (seeded > 0 && seeded < SEED_POINTS) {
        console.log(`  Series ${eventId}: ${seeded}/${SEED_POINTS} points (partial)`);
      }
    }
    if (seriesEventIds.length > 0) {
      console.log(`  Created ${seriesEventIds.length} series events (${SEED_POINTS} points each)`);
    }

    seedResult.users.push({
      username,
      masterToken,
      restrictedToken,
      restrictedStreams,
      streams: leafStreamIds,
      parentStreams: parentStreamIds,
      seriesEventIds,
      seedTime: Date.now() / 1000,
      eventsCreated: createdCount
    });
  }

  // capture post-seed storage snapshot
  const storageAfterSeed = snapshotStorageSizes();
  const seedStorageDelta = storageDelta(storageBaseline, storageAfterSeed);

  seedResult.storage = {
    baseline: storageBaseline,
    afterSeed: storageAfterSeed,
    seedDelta: seedStorageDelta
  };

  console.log('\nSeed storage cost:');
  console.log(formatStorageSizes(seedStorageDelta));

  // write result
  const outPath = new URL('seed-result.json', import.meta.url).pathname;
  fs.writeFileSync(outPath, JSON.stringify(seedResult, null, 2) + '\n');
  console.log(`\nSeed result written to: ${outPath}`);
  console.log(`Users created: ${seedResult.users.length}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
