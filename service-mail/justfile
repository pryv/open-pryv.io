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

# Install node modules
install *params:
    npm install {{params}}

# Install node modules strictly as specified (typically for CI)
install-stable:
    npm ci

# –––––––––––––----------------------------------------------------------------
# Run
# –––––––––––––----------------------------------------------------------------

# Start the server
start:
    NODE_ENV=development ./bin/server

# –––––––––––––----------------------------------------------------------------
# Test & related
# –––––––––––––----------------------------------------------------------------

# Run tests with optional extra parameters
test *params:
    NODE_ENV=test mocha {{params}}

# Run tests with detailed output
test-detailed *params:
    NODE_ENV=test mocha --reporter=spec {{params}}

# Run tests with detailed output for debugging
test-debug *params:
    NODE_ENV=test mocha --timeout 3600000 --reporter=spec --inspect-brk=40000 {{params}}

# Run tests and generate HTML coverage report
test-cover *params:
    NODE_ENV=test nyc --reporter=lcov --reporter=text --report-dir=./coverage mocha {{params}}

# Run code linting
lint *params:
    semistandard {{params}}

# –––––––––––––----------------------------------------------------------------
# Misc. utils
# –––––––––––––----------------------------------------------------------------

# Run source licensing tool (see 'licensing' folder for details)
license:
    source-licenser --config-file .licenser.yml ./
