#!/bin/bash
# Run Pattern C tests in parallel
# These tests use supertest without binding to real ports, so they can run in parallel

# Pattern C test files (safe for parallel execution)
PATTERN_C_TESTS=(
  "test/permissions-none.test.js"
  "test/permissions-selfRevoke.test.js"
  "test/permissions-create-only.test.js"
  "test/permissions-forcedStreams.test.js"
  "test/service-info.test.js"
  "test/profile-app.test.js"
  "test/profile-personal.test.js"
  "test/accesses-app.test.js"
  "test/accesses-personal.test.js"
  "test/events-mutiple-streamIds.test.js"
  "test/events.get-streams-query.test.js"
  "test/webhooks.test.js"
)

# Default number of parallel jobs
JOBS=${1:-4}

echo "Running ${#PATTERN_C_TESTS[@]} Pattern C test files in parallel with $JOBS jobs..."

DISABLE_INTEGRITY_CHECK=1 npx mocha --no-config --parallel --jobs "$JOBS" \
  --require test-helpers/src/helpers-c.js \
  --exit --timeout 15000 \
  "${PATTERN_C_TESTS[@]}"
