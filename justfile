# add node bin script path for recipes
export PATH := "./node_modules/.bin:" + env_var('PATH')

# Default: display available recipes
_help:
    @just --list

# –––––––––––––----------------------------------------------------------------
# Setup
# –––––––––––––----------------------------------------------------------------

# Set up the dev environment on a MacOS or GNU/Linux system
setup-dev-env:
    scripts/setup-dev-env

# Install node modules afresh (no optionals)
install *params: clean
    npm install --omit=optional {{params}}

# Clean up node modules
clean:
    rm -rf node_modules
    rm -rf components/**/node_modules

# Install node modules strictly as specified (typically for CI)
install-stable:
    npm ci

# –––––––––––––----------------------------------------------------------------
# Run
# –––––––––––––----------------------------------------------------------------

# Run optional dependency services (e.g. Influx for HF series)
start-deps:
    DEVELOPMENT=true influxd

# Start the master process (cluster mode with N API workers)
start-master *params:
    NODE_ENV=development node bin/master.js {{params}}

# Start the given server component for dev (expects '{component}/bin/server')
start component *params:
    cd components/{{component}} && \
    NODE_ENV=development bin/server {{params}}

# Start the given server component for dev, automatically restarting on file changes (requires nodemon)
start-mon component:
    cd components/{{component}} && \
    NODE_ENV=development nodemon bin/server

# Run the given component binary for dev (expects '{component}/bin/{bin}')
run component bin:
    cd components/{{component}} && \
    NODE_ENV=development bin/{{bin}}

# –––––––––––––----------------------------------------------------------------
# Test & related
# –––––––––––––----------------------------------------------------------------

# Run code linting on the entire repo (JS style + TS `any` gate + open-type ratchet)
lint *options: && lint-ts-any lint-open-types
    eslint {{options}} .

# TypeScript `any` gate: no-explicit-any on TS sources (see eslint.ts-any.config.js)
lint-ts-any:
    eslint --config eslint.ts-any.config.js 'components/**/*.ts' 'storages/**/*.ts'

# Open-index-signature ratchet: `[k: string]: unknown` site count may only go down
lint-open-types:
    ./scripts/open-type-ratchet

# Run code linting only on changed files (excludes deleted files)
lint-changes *options:
    eslint {{options}} $(git diff --name-only --diff-filter=d HEAD | grep -E '\.(js|jsx)$' | xargs)

# Tag each test with a unique id if missing
tag-tests:
    scripts/tag-tests

# Run tests on the given component ('all' for all components) with optional extra parameters.
# PostgreSQL is the default baseStorage; SQLite is the alternative — use `test-sqlite`.
test component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Same as `test` but using the SQLite baseStorage engine
test-sqlite component *params:
    STORAGE_ENGINE=sqlite NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run tests with detailed output (PG default)
test-detailed component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --reporter=spec {{params}}

# Run tests with detailed output for debugging (PG default)
test-debug component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --timeout 3600000 --reporter=spec --inspect-brk=40000 {{params}}

# Run tests with parallel file execution (PG default; excludes tests that can't parallelize)
# Uses MOCHA_PARALLEL=1 to enable parallel mode in .mocharc.js
test-parallel component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test MOCHA_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run parallel tests first, then sequential tests (PG default)
test-fast component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test MOCHA_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}} && \
    STORAGE_ENGINE=postgresql NODE_ENV=test MOCHA_NON_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run only non-parallel tests (PG default; use after test-parallel to run the remaining tests sequentially)
test-non-parallel component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test MOCHA_NON_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# ⚠️  OBSOLETE?: Run tests for profiling (PG default)
test-profile component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --profile=true {{params}} && \
    tick-processor > profiling-output.txt && \
    open profiling-output.txt

# Run tests and generate HTML coverage report for a single component (PG default)
test-cover component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} nyc \
        scripts/components-run npx mocha -- {{params}}

# Run all tests across supported engines (PG + SQLite) and generate coverage report
test-cover-all:
    scripts/coverage
    npx nyc report

# Full coverage: runs mocha from project root so storages/engines/ files are instrumented
test-cover-full *engines:
    tools/coverage/run.sh {{engines}}

# Run all tests with LCOV output (for CI)
test-cover-lcov:
    scripts/coverage
    npx nyc report --reporter=lcov

# Set up test results report generation
test-results-init-repo:
    scripts/test-results/init-repo

# Generate test results report
test-results-generate:
    node scripts/test-results/generate

# Upload test results report
test-results-upload:
    scripts/test-results/upload

# Run tracing service (Jaeger)
trace:
    open http://localhost:16686/
    docker run --rm -p 6831:6831/udp -p 6832:6832/udp -p 16686:16686 jaegertracing/all-in-one:1.7 --log-level=debug

# Dump/restore test data; command must be 'dump' or 'restore'
test-data command version:
    NODE_ENV=development node components/test-helpers/scripts/{{command}}-test-data {{version}}

# Reset test state: SQLite DBs + per-user dirs + PG test databases
clean-test-data:
    #!/usr/bin/env bash
    set -uo pipefail
    # Resolve PG client binaries: prefer the local from-source install at
    # ./var-pryv/postgresql-bin/bin/ (Linux dev + Darwin dev when the
    # PG setup script ran), fall back to system `dropdb`/`createdb`
    # found on PATH (Darwin operators using Homebrew / Postgres.app /
    # the system PG that ships with macOS).
    if [ -x ./var-pryv/postgresql-bin/bin/dropdb ]; then
      DROPDB=./var-pryv/postgresql-bin/bin/dropdb
      CREATEDB=./var-pryv/postgresql-bin/bin/createdb
    else
      DROPDB=$(command -v dropdb || true)
      CREATEDB=$(command -v createdb || true)
    fi
    # SQLite user index + legacy platform-wide.db from before the rqlite platform engine (retained for safety)
    rm -f ./var-pryv/users/user-index.db ./var-pryv/users/user-index.db-wal ./var-pryv/users/user-index.db-shm
    rm -f ./var-pryv/users/platform-wide.db ./var-pryv/users/platform-wide.db-wal ./var-pryv/users/platform-wide.db-shm
    # Per-user directories (each holds the user's audit SQLite + the SQLite
    # baseStorage file when the SQLite engine is in use).
    find ./var-pryv/users -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
    # Filesystem-engine storage roots (attachments + previews live at
    # var-pryv/<dir> by default per override-config.yml, NOT under
    # users/, so the find above doesn't touch them).
    rm -rf ./var-pryv/attachments/* ./var-pryv/previews/* 2>/dev/null || true
    # PostgreSQL databases — drop+recreate
    # both pryv-node-test (test harness) AND pryv-node (local dev /
    # bin/master.js). Tests re-run migrations on next startup; the
    # local server runs them on next master boot.
    # Wrap dropdb/createdb in `timeout` (GNU coreutils on Linux; absent on
    # default macOS) so a misbehaving PG (held connections, auth prompt
    # waiting on stdin, …) can't hang the whole recipe — observed on CI
    # runners as 38-minute silent stalls. Darwin operators skip the wrapper
    # since they typically don't share the runner's flakiness profile.
    if command -v timeout >/dev/null 2>&1; then
      TIMEOUT="timeout 30"
    else
      TIMEOUT=""
    fi
    # Engine host/port: honor the same env overrides the test commands use
    # (parallel dev setups run several checkouts against per-checkout
    # PG/rqlite instances on offset ports — resetting the default ports
    # from such a checkout would wipe ANOTHER checkout's databases while
    # leaving this one dirty).
    PG_HOST="${storages__engines__postgresql__host:-127.0.0.1}"
    PG_PORT="${storages__engines__postgresql__port:-5432}"
    RQLITE_HOST="${storages__engines__rqlite__host:-localhost}"
    RQLITE_PORT="${storages__engines__rqlite__port:-4001}"
    if [ -n "$DROPDB" ] && [ -n "$CREATEDB" ]; then
      ($TIMEOUT "$DROPDB" -h "$PG_HOST" -p "$PG_PORT" -U pryv --if-exists --force pryv-node-test 2>/dev/null && \
          $TIMEOUT "$CREATEDB" -h "$PG_HOST" -p "$PG_PORT" -U pryv pryv-node-test 2>/dev/null) || echo "PostgreSQL not reachable (skipping pg test reset)"
      ($TIMEOUT "$DROPDB" -h "$PG_HOST" -p "$PG_PORT" -U pryv --if-exists --force pryv-node 2>/dev/null && \
          $TIMEOUT "$CREATEDB" -h "$PG_HOST" -p "$PG_PORT" -U pryv pryv-node 2>/dev/null) || echo "PostgreSQL not reachable (skipping pg dev reset)"
    else
      echo "dropdb/createdb not found (skipping pg test reset + pg dev reset)"
    fi
    # rqlite PlatformDB — full state reset (rqlite is the only platform
    # engine). Paired with the PG dev-DB drop above so the platform DB
    # and the user index can't diverge across cleans.
    # "DELETE FROM keyValue" alone is NOT enough: the raft log + on-disk
    # db.sqlite retain historical writes that replay on restart, and after
    # many runs the integrity check observes ghost users (api-server
    # matrix degrades from ~1068 passing to ~252). So for the canonical
    # pidfile-managed local instance: stop it, wipe the raft + db files,
    # restart. Overridden host/port (parallel workspaces / remote rqlite)
    # keep the keyValue-only wipe — their data dir is not ours to touch.
    if [ "$RQLITE_PORT" = "4001" ] && { [ "$RQLITE_HOST" = "localhost" ] || [ "$RQLITE_HOST" = "127.0.0.1" ]; } && [ -f ./var-pryv/rqlite-data/rqlited.pid ]; then
      RQLITED_PID=$(cat ./var-pryv/rqlite-data/rqlited.pid)
      kill "$RQLITED_PID" 2>/dev/null || true
      for i in $(seq 1 40); do kill -0 "$RQLITED_PID" 2>/dev/null || break; sleep 0.25; done
      rm -rf ./var-pryv/rqlite-data/db.sqlite* ./var-pryv/rqlite-data/raft ./var-pryv/rqlite-data/raft.db \
             ./var-pryv/rqlite-data/wsnapshots ./var-pryv/rqlite-data/clean_snapshot ./var-pryv/rqlite-data/rqlited.pid
      ./storages/engines/rqlite/scripts/start > /dev/null 2>&1 || echo "rqlited restart FAILED — run storages/engines/rqlite/scripts/start manually"
    else
      curl -s -X POST -H 'Content-Type: application/json' "http://${RQLITE_HOST}:${RQLITE_PORT}/db/execute" -d '[["DELETE FROM keyValue"]]' > /dev/null 2>&1 || echo "rqlite not reachable (skipping rqlite reset)"
      echo "rqlite at ${RQLITE_HOST}:${RQLITE_PORT} (non-canonical or unmanaged): wiped keyValue only — for a full raft-state reset stop that rqlited, wipe its data dir, restart it"
    fi
    # Stale customAuthStepFn from a prior aborted permissions-seq test (the [P4OM] invalid-fixture test crashes the api-server bin and leaves the file behind, polluting subsequent matrix runs with [api-server fatal] Not a function (string)). Safe to delete unconditionally — committed file is .gitkeep.
    rm -f ./custom-extensions/customAuthStepFn.js
    echo "Test data cleaned: SQLite + per-user dirs + attachments/previews + PG (pryv-node-test + pryv-node) + rqlite keyValue + custom-extensions stale fixture"

# Reset per-worker test state for parallel mode. Wipes worker-private
# PG DBs (pryv-node-test-w0..N), per-worker user
# dirs (var-pryv/users-test-w*/), per-worker previews + rqlite data
# dirs, and kills any lingering rqlited PIDs referenced in worker
# pidfiles.
#
# WORKERS default = empty → auto-derive to match `.mocharc.js`
# `defaultParallelJobs`: `MOCHA_JOBS` env if set, else `max(2, cpus-1)`.
# This keeps the cleanup sized for the actual parallel-mode worker count
# on machines with >8 cores.
#
# The dev-host rqlited at port 4001 is left running on purpose; parallel
# mode workers use offset ports (4011/4021/…). If a previous run crashed
# while worker 0's port collided with the host rqlited, kill the host
# rqlited yourself before re-running parallel tests.
clean-test-data-parallel WORKERS='':
    #!/usr/bin/env bash
    set -euo pipefail
    WORKERS='{{WORKERS}}'
    if [ -z "$WORKERS" ]; then
      if [ -n "${MOCHA_JOBS:-}" ]; then
        WORKERS=$MOCHA_JOBS
      else
        if command -v nproc >/dev/null 2>&1; then
          N=$(nproc)
        else
          N=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
        fi
        WORKERS=$(( N > 2 ? N - 1 : 2 ))
      fi
    fi
    # Resolve PG binaries (mirror of `clean-test-data`): prefer the local
    # from-source install at ./var-pryv/postgresql-bin/bin/, fall back to
    # system tooling on PATH (Darwin Homebrew / Postgres.app).
    if [ -x ./var-pryv/postgresql-bin/bin/dropdb ]; then
      DROPDB=./var-pryv/postgresql-bin/bin/dropdb
      CREATEDB=./var-pryv/postgresql-bin/bin/createdb
    else
      DROPDB=$(command -v dropdb || true)
      CREATEDB=$(command -v createdb || true)
    fi
    # Parallelize the per-worker cleanup. Each iteration is independent
    # (different DB name + dir paths), so they can fan out via background
    # jobs + `wait`. Wall time on the dev box dropped from ~13s to ~3s
    # for 8 workers.
    cleanup_worker () {
      local i=$1
      local DB="pryv-node-test-w$i"
      local USR="./var-pryv/users-test-w$i"
      local PRV="./var-pryv/previews-test-w$i"
      local RQD="./var-pryv/rqlite-data-w$i"
      local CEX="./var-pryv/custom-extensions-w$i"
      local PID="$RQD/rqlited.pid"
      if [ -f "$PID" ]; then
        kill "$(cat "$PID")" 2>/dev/null || true
        sleep 0.2
        kill -KILL "$(cat "$PID")" 2>/dev/null || true
        rm -f "$PID"
      fi
      if [ -n "$DROPDB" ] && [ -n "$CREATEDB" ]; then
        "$DROPDB" -h 127.0.0.1 -p 5432 -U pryv --if-exists "$DB" 2>/dev/null || true
        "$CREATEDB" -h 127.0.0.1 -p 5432 -U pryv "$DB" 2>/dev/null || true
      fi
      rm -rf "$USR" "$PRV" "$RQD" "$CEX"
    }
    for i in $(seq 0 $(( WORKERS - 1 ))); do
      cleanup_worker "$i" &
    done
    wait
    # Sweep any rqlited processes pointing at the worker data dirs but
    # missing/stale pidfiles (covers SIGKILL'd or crashed workers).
    pkill -f 'rqlited.*var-pryv/rqlite-data-w' 2>/dev/null || true
    echo "Parallel worker test data cleaned (workers 0..$(( WORKERS - 1 )))"

# Cleanup users data in `var-pryv/`
clean-data:
    rm -rf ./var-pryv/users/*

# Run security assessment and output to `security-assessment`
security-assessment:
    rm -rf ./security-assessment/
    mkdir -p ./security-assessment/source-code
    cp -rv justfile ./components package* README.md test scripts build .eslintrc.yml .mocharc.js LICENSE CHANGELOG.md ./security-assessment/source-code/
    cp -rv coverage ./security-assessment/
    npm audit --json > ./security-assessment/npm-audit-result.json

# Run OWASP ZAP, writing output to `security-assessment` (requires OWASP ZAP app)
security-assessment-owasp:
    echo "make sure to start api-server with: just start api-server"
    /Applications/OWASP\ ZAP.app/Contents/Java/zap.sh  -quickurl http://127.0.0.1:3000 -quickout /tmp/owasp-zap-automated-scan.html
    cp /tmp/owasp-zap-automated-scan.html ./security-assessment/

# Run Grype audit, writing output to `security-assessment` (requires Grype and local Docker containers)
security-assessment-grype:
    mkdir -p ./security-assessment/
    grype local/pryvio/open-pryv.io:test  -o template -t build/grype-html.tmpl > ./security-assessment/grype.html

# –––––––––––––----------------------------------------------------------------
# Misc. utils
# –––––––––––––----------------------------------------------------------------

# Update default event types from online reference
update-event-types:
    scripts/update-event-types

# Run source licensing tool (see 'licensing' folder for details)
license:
    source-licenser --config-file .licenser.yml ./

# Set version on all 'package.json' (root’s and components’)
version version:
    npm version --no-git-tag-version --workspaces --include-workspace-root {{version}}

# –––––––––––––----------------------------------------------------------------
# TypeScript — incremental migration to TS+ESM, currently CJS-emit
# –––––––––––––----------------------------------------------------------------

# Run the TypeScript compiler in check-only mode (no emit)
typecheck:
    tsc --noEmit -p tsconfig.json

# Report TS type coverage (share of expressions with a non-any type).
# Baseline 81.77% (2026-06-11, post interface-IO typing); --at-least guards against regressions.
type-coverage:
    npx type-coverage -p tsconfig.json --at-least 81
