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

# Install node modules afresh
install *params: clean
    npm install {{params}}

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

# Run all dependency services (e.g. nats server, Mongo, Influx…)
start-deps:
    DEVELOPMENT=true concurrently --names "nats,mongo,influx" \
        --prefix-colors "cyan,green,magenta" \
        nats-server scripts/start-mongo influxd

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

# Run code linting only on changed files
lint-changes *options:
    eslint {{options}} $(git diff --name-only HEAD | grep -E '\.(js|jsx)$' | xargs)

# Tag each test with a unique id if missing
tag-tests:
    scripts/tag-tests

# Run tests on the given component ('all' for all components) with optional extra parameters
test component *params:
    NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- {{params}}

# Same as `test` but using SQLite PoC storage
test-sqlite component *params:
    database__engine=sqlite NODE_ENV=test COMPONENT={{component}} scripts/components-run  \
        npx mocha -- {{params}}

# Run tests with detailed output
test-detailed component *params:
    NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --reporter=spec {{params}}

# Run tests with detailed output for debugging
test-debug component *params:
    NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --timeout 3600000 --reporter=spec --inspect-brk=40000 {{params}}

# ⚠️  OBSOLETE?: Run tests for profiling
test-profile component *params:
    NODE_ENV=test COMPONENT={{component}} scripts/components-run \
        npx mocha -- --profile=true {{params}} && \
    tick-processor > profiling-output.txt && \
    open profiling-output.txt

# Run tests and generate HTML coverage report
test-cover component *params:
    NODE_ENV=test COMPONENT={{component}} nyc --reporter=html --report-dir=./coverage \
        scripts/components-run npx mocha -- {{params}}

# Run all possible tests (with both Mongo and SQLite storage) and generate HTML coverage report
test-cover-all:
    NODE_ENV=test nyc --reporter=html --report-dir=./coverage scripts/coverage

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

# Cleanup users data and MongoDB data in `var-pryv/`
clean-data:
    rm -rf ./var-pryv/users/*
    (killall mongod && sleep 2) || echo "MongoDB was not running"
    rm -rf ./var-pryv/mongodb-data/*
    DEVELOPMENT=true ./scripts/start-mongo

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
    grype local/pryvio/core:test  -o template -t build/grype-html.tmpl > ./security-assessment/grype.html

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
