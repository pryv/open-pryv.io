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

# Run all dependency services (e.g. Mongo, Influx…)
start-deps:
    DEVELOPMENT=true concurrently --names "mongo,influx" \
        --prefix-colors "green,magenta" \
        storages/engines/mongodb/scripts/start influxd

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

# Run code linting on the entire repo
lint *options:
    eslint {{options}} .

# Run code linting only on changed files (excludes deleted files)
lint-changes *options:
    eslint {{options}} $(git diff --name-only --diff-filter=d HEAD | grep -E '\.(js|jsx)$' | xargs)

# Tag each test with a unique id if missing
tag-tests:
    scripts/tag-tests

# Run tests on the given component ('all' for all components) with optional extra parameters.
# PostgreSQL is the default baseStorage — use `test-mongo` for Mongo.
test component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Same as `test` but using MongoDB baseStorage
test-mongo component *params:
    STORAGE_ENGINE=mongodb NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Same as `test-parallel` but using MongoDB baseStorage
test-mongo-parallel component *params:
    STORAGE_ENGINE=mongodb NODE_ENV=test MOCHA_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Same as `test` but using SQLite PoC storage
test-sqlite component *params:
    STORAGE_ENGINE=sqlite NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run tests with storages: [Platform, userStorage, usersIndex] using mongoDB engine and not sqLite
test-full-mongo component *params:
    storagePlatform__engine=mongodb storageUserAccount__engine=mongodb storageUserIndex__engine=mongodb \
        NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run tests with detailed output (PG default — prefix with `STORAGE_ENGINE=mongodb` for Mongo)
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

# Run all tests across all engines (MongoDB + PG + SQLite) and generate coverage report
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

# Dump/restore MongoDB test data; command must be 'dump' or 'restore'
test-data command version:
    NODE_ENV=development node components/test-helpers/scripts/{{command}}-test-data {{version}}

# Reset test state: SQLite DBs, user dirs, and MongoDB user collections (keeps MongoDB running)
clean-test-data:
    #!/usr/bin/env bash
    set -uo pipefail
    # Resolve PG client binaries: prefer the local Plan-41 install at
    # ./var-pryv/postgresql-bin/bin/ (Linux dev + Darwin dev when the
    # PG setup script ran), fall back to system `dropdb`/`createdb`
    # found on PATH (Darwin operators using Homebrew / Postgres.app /
    # the system PG that ships with macOS). Same for `mongosh`. If
    # neither resolves, the recipe still reports the skip — but at
    # least the local-bin-missing case no longer hides the issue from
    # operators who DO have the system tools installed.
    if [ -x ./var-pryv/postgresql-bin/bin/dropdb ]; then
      DROPDB=./var-pryv/postgresql-bin/bin/dropdb
      CREATEDB=./var-pryv/postgresql-bin/bin/createdb
    else
      DROPDB=$(command -v dropdb || true)
      CREATEDB=$(command -v createdb || true)
    fi
    if [ -x ./var-pryv/mongodb-bin/bin/mongosh ]; then
      MONGOSH=./var-pryv/mongodb-bin/bin/mongosh
    else
      MONGOSH=$(command -v mongosh || true)
    fi
    # SQLite user index + legacy pre-Plan-25 platform-wide.db (retained for safety)
    rm -f ./var-pryv/users/user-index.db ./var-pryv/users/user-index.db-wal ./var-pryv/users/user-index.db-shm
    rm -f ./var-pryv/users/platform-wide.db ./var-pryv/users/platform-wide.db-wal ./var-pryv/users/platform-wide.db-shm
    # Per-user directories (each holds the user's audit SQLite + any
    # stray writes from older engine paths).
    find ./var-pryv/users -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
    # Filesystem-engine storage roots (attachments + previews live at
    # var-pryv/<dir> by default per override-config.yml, NOT under
    # users/, so the find above doesn't touch them).
    rm -rf ./var-pryv/attachments/* ./var-pryv/previews/* 2>/dev/null || true
    # MongoDB databases — wipe BOTH the test DB and the local dev DB
    # (pryv-node). Without the latter, users provisioned by `node
    # bin/master.js` against override-config.yml persist across
    # cleans and cause "user exists in repo but missing in index"
    # symptoms on the next prepare (e.g. lib-js's [UEMX]). The mongo
    # server is kept running.
    if [ -n "$MONGOSH" ]; then
      "$MONGOSH" --quiet pryv-node-test --eval 'db.dropDatabase()' > /dev/null 2>&1 || echo "MongoDB not reachable (skipping mongo test reset)"
      "$MONGOSH" --quiet pryv-node --eval 'db.dropDatabase()' > /dev/null 2>&1 || echo "MongoDB not reachable (skipping mongo dev reset)"
    else
      echo "mongosh not found (skipping mongo test reset + mongo dev reset)"
    fi
    # PostgreSQL databases — same logic as Mongo above: drop+recreate
    # both pryv-node-test (test harness) AND pryv-node (local dev /
    # bin/master.js). Tests re-run migrations on next startup; the
    # local server runs them on next master boot.
    if [ -n "$DROPDB" ] && [ -n "$CREATEDB" ]; then
      ("$DROPDB" -h 127.0.0.1 -p 5432 -U pryv --if-exists pryv-node-test 2>/dev/null && \
          "$CREATEDB" -h 127.0.0.1 -p 5432 -U pryv pryv-node-test 2>/dev/null) || echo "PostgreSQL not reachable (skipping pg test reset)"
      ("$DROPDB" -h 127.0.0.1 -p 5432 -U pryv --if-exists pryv-node 2>/dev/null && \
          "$CREATEDB" -h 127.0.0.1 -p 5432 -U pryv pryv-node 2>/dev/null) || echo "PostgreSQL not reachable (skipping pg dev reset)"
    else
      echo "dropdb/createdb not found (skipping pg test reset + pg dev reset)"
    fi
    # rqlite PlatformDB key-value table (rqlite is the only platform
    # engine). Wipes both the test harness state AND the local-dev
    # email/platform-unique index — paired with the PG dev-DB drop
    # above so the platform DB and the user index can't diverge
    # across cleans.
    curl -s -X POST -H 'Content-Type: application/json' 'http://localhost:4001/db/execute' -d '[["DELETE FROM keyValue"]]' > /dev/null 2>&1 || echo "rqlite not reachable (skipping rqlite reset)"
    # Stale customAuthStepFn from a prior aborted permissions-seq test (the [P4OM] invalid-fixture test crashes the api-server bin and leaves the file behind, polluting subsequent matrix runs with [api-server fatal] Not a function (string)). Safe to delete unconditionally — committed file is .gitkeep.
    rm -f ./custom-extensions/customAuthStepFn.js
    echo "Test data cleaned: SQLite + per-user dirs + attachments/previews + Mongo (pryv-node-test + pryv-node) + PG (pryv-node-test + pryv-node) + rqlite keyValue + custom-extensions stale fixture"

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
    # Resolve PG + mongosh binaries (mirror of `clean-test-data`): prefer
    # the local Plan-41 install at ./var-pryv/<engine>-bin/bin/, fall
    # back to system tooling on PATH (Darwin Homebrew / Postgres.app).
    if [ -x ./var-pryv/postgresql-bin/bin/dropdb ]; then
      DROPDB=./var-pryv/postgresql-bin/bin/dropdb
      CREATEDB=./var-pryv/postgresql-bin/bin/createdb
    else
      DROPDB=$(command -v dropdb || true)
      CREATEDB=$(command -v createdb || true)
    fi
    if [ -x ./var-pryv/mongodb-bin/bin/mongosh ]; then
      MONGOSH=./var-pryv/mongodb-bin/bin/mongosh
    else
      MONGOSH=$(command -v mongosh || true)
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
      if [ -n "$MONGOSH" ]; then
        "$MONGOSH" --quiet "$DB" --eval 'db.dropDatabase()' >/dev/null 2>&1 || true
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

# Cleanup users data and MongoDB data in `var-pryv/`
clean-data:
    rm -rf ./var-pryv/users/*
    (killall mongod && sleep 2) || echo "MongoDB was not running"
    rm -rf ./var-pryv/mongodb-data/*
    DEVELOPMENT=true ./storages/engines/mongodb/scripts/start

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
