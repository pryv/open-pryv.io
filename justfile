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
# PostgreSQL is the default baseStorage since Plan 49 — use `test-mongo` for Mongo.
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
    database__engine=sqlite NODE_ENV=test COMPONENT={{component}} scripts/components-run \
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
    STORAGE_ENGINE=postgresql NODE_ENV=test DISABLE_INTEGRITY_CHECK=1 MOCHA_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Run parallel tests first, then sequential tests (PG default)
test-fast component *params:
    STORAGE_ENGINE=postgresql NODE_ENV=test DISABLE_INTEGRITY_CHECK=1 MOCHA_PARALLEL=1 COMPONENT={{component}} scripts/components-run \
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
    # SQLite user index + legacy pre-Plan-25 platform-wide.db (retained for safety)
    rm -f ./var-pryv/users/user-index.db ./var-pryv/users/user-index.db-wal ./var-pryv/users/user-index.db-shm
    rm -f ./var-pryv/users/platform-wide.db ./var-pryv/users/platform-wide.db-wal ./var-pryv/users/platform-wide.db-shm
    # Per-user directories
    find ./var-pryv/users -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
    # MongoDB test database (reset only — keeps server running)
    ./var-pryv/mongodb-bin/bin/mongosh --quiet pryv-node-test --eval 'db.dropDatabase()' > /dev/null 2>&1 || echo "MongoDB not reachable (skipping mongo reset)"
    # PostgreSQL test database (drop + recreate — tests re-run migrations on startup)
    (./var-pryv/postgresql-bin/bin/dropdb -h 127.0.0.1 -p 5432 -U pryv --if-exists pryv-node-test 2>/dev/null && \
        ./var-pryv/postgresql-bin/bin/createdb -h 127.0.0.1 -p 5432 -U pryv pryv-node-test 2>/dev/null) || echo "PostgreSQL not reachable (skipping pg reset)"
    # rqlite PlatformDB key-value table (Plan 25: rqlite is the only platform engine)
    curl -s -X POST -H 'Content-Type: application/json' 'http://localhost:4001/db/execute' -d '[["DELETE FROM keyValue"]]' > /dev/null 2>&1 || echo "rqlite not reachable (skipping rqlite reset)"
    @echo "Test data cleaned (SQLite DBs + user dirs + MongoDB pryv-node-test + PostgreSQL pryv-node-test + rqlite keyValue)"

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
# TypeScript (Plan 57 — incremental migration to TS+ESM, currently CJS-emit)
# –––––––––––––----------------------------------------------------------------

# Run the TypeScript compiler in check-only mode (no emit)
typecheck:
    tsc --noEmit -p tsconfig.json

# Build the TypeScript project to ./dist (CJS). Until Phase 5, runtime keeps
# loading from source under components/ + storages/, so dist/ is informational.
build:
    rm -rf dist
    tsc -p tsconfig.json --noEmit false
