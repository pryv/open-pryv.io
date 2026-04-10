/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { parseArgs } from 'node:util';

const defaults = {
  target: 'http://127.0.0.1:3000',
  hfsTarget: null, // defaults to target on port 4000
  scenario: null,
  concurrency: 10,
  duration: 30, // seconds
  label: '',
  users: 5,
  events: 50000,
  profile: 'manual', // 'manual' or 'iot'
  matrix: false,
  seedFile: null, // path to seed-result.json
  clean: false, // cleanup mode: delete seeded users via API
  adminKey: 'CHANGE_ME_WITH_SOMETHING', // auth:adminAccessKey for system API
  sweep: null, // concurrency sweep: comma-separated levels e.g. "1,5,10,25,50"
  all: false // run all scenarios in one combined result
};

const argSpec = {
  target: { type: 'string', short: 't' },
  'hfs-target': { type: 'string' },
  scenario: { type: 'string', short: 's' },
  concurrency: { type: 'string', short: 'c' },
  duration: { type: 'string', short: 'd' },
  label: { type: 'string', short: 'l' },
  users: { type: 'string' },
  events: { type: 'string' },
  profile: { type: 'string', short: 'p' },
  matrix: { type: 'boolean', short: 'm' },
  'seed-file': { type: 'string', short: 'f' },
  clean: { type: 'boolean' },
  'admin-key': { type: 'string' },
  sweep: { type: 'string' },
  all: { type: 'boolean', short: 'a' },
  help: { type: 'boolean', short: 'h' }
};

export function parseConfig (argv) {
  const { values } = parseArgs({ args: argv, options: argSpec, strict: false });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const config = { ...defaults };
  if (values.target) config.target = values.target;
  if (values['hfs-target']) config.hfsTarget = values['hfs-target'];
  if (values.scenario) config.scenario = values.scenario;
  if (values.concurrency) config.concurrency = parseInt(values.concurrency, 10);
  if (values.duration) config.duration = parseInt(values.duration, 10);
  if (values.label) config.label = values.label;
  if (values.users) config.users = parseInt(values.users, 10);
  if (values.events) config.events = parseInt(values.events, 10);
  if (values.profile) config.profile = values.profile;
  if (values.matrix) config.matrix = true;
  if (values['seed-file']) config.seedFile = values['seed-file'];
  if (values.clean) config.clean = true;
  if (values['admin-key']) config.adminKey = values['admin-key'];
  if (values.sweep) config.sweep = values.sweep.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  if (values.all) config.all = true;

  // env overrides
  if (process.env.BENCH_TARGET) config.target = process.env.BENCH_TARGET;
  if (process.env.BENCH_CONCURRENCY) config.concurrency = parseInt(process.env.BENCH_CONCURRENCY, 10);
  if (process.env.BENCH_DURATION) config.duration = parseInt(process.env.BENCH_DURATION, 10);

  // derive hfsTarget if not set
  if (!config.hfsTarget) {
    const url = new URL(config.target);
    url.port = '4000';
    config.hfsTarget = url.toString().replace(/\/$/, '');
  }

  return config;
}

function printHelp () {
  console.log(`
Usage: node bin/run-benchmark.js [options]

Options:
  -t, --target <url>       API server URL (default: http://127.0.0.1:3000)
      --hfs-target <url>   HFS server URL (default: target on port 4000)
  -s, --scenario <name>    Scenario to run (events-create, events-get, streams-create,
                           streams-update, series-write, series-read, mixed-workload)
  -c, --concurrency <n>    Concurrent requests (default: 10)
  -d, --duration <s>       Test duration in seconds (default: 30)
  -l, --label <text>       Label for result files
  -f, --seed-file <path>   Path to seed-result.json
  -m, --matrix             Run all scenario × config combinations
  -h, --help               Show this help

Seed options (for datasets/seed.js):
      --users <n>          Number of test users (default: 5)
      --events <n>         Events per user (default: 50000)
  -p, --profile <type>     Data profile: manual or iot (default: manual)
      --clean              Delete previously seeded users (reads seed-result.json)
      --admin-key <key>    System admin key (default: dev config value)
      --sweep <levels>     Concurrency sweep: comma-separated (e.g. "1,5,10,25,50,100")
  -a, --all                Run all scenarios, produce one combined result file

Environment variables:
  BENCH_TARGET             Override --target
  BENCH_CONCURRENCY        Override --concurrency
  BENCH_DURATION           Override --duration
`.trim());
}
