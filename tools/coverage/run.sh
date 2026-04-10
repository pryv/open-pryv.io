#!/bin/bash

# @license
# Copyright (C) Pryv https://pryv.com
# This file is part of Pryv.io and released under BSD-Clause-3 License
# Refer to LICENSE file

# Full coverage collection across all storage engines.
#
# Uses NODE_V8_COVERAGE (V8-native coverage) instead of NYC instrumentation.
# collect.js runs mocha via `node` directly (not npx) so V8 can track all
# loaded files including lazy-required engine implementations.
#
# Usage:
#   tools/coverage/run.sh              # all engines
#   tools/coverage/run.sh postgresql   # single engine
#   tools/coverage/run.sh --report     # just regenerate report from existing data

set -e
cd "$(dirname "$0")/../.."  # service-core root

V8DIR=".v8-coverage"
REPORT_ONLY=false
ENGINES=()

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --report) REPORT_ONLY=true ;;
    mongodb|postgresql|sqlite) ENGINES+=("$arg") ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Default: all engines
if [ ${#ENGINES[@]} -eq 0 ] && [ "$REPORT_ONLY" = false ]; then
  ENGINES=(mongodb postgresql sqlite)
fi

if [ "$REPORT_ONLY" = false ]; then
  rm -rf "$V8DIR" coverage
  mkdir -p "$V8DIR"

  run_engine() {
    local engine="$1"

    echo ""
    echo "========================================"
    echo "  Coverage: ${engine}"
    echo "========================================"

    # Clean user data but don't restart MongoDB (clean-data blocks in dev mode)
    rm -rf var-pryv/users/* 2>/dev/null || true

    local env_vars="NODE_ENV=test NODE_V8_COVERAGE=$(pwd)/$V8DIR"
    case "$engine" in
      mongodb)
        ;;
      postgresql)
        env_vars="STORAGE_ENGINE=postgresql $env_vars"
        ;;
      sqlite)
        env_vars="database__engine=sqlite $env_vars"
        ;;
    esac

    env $env_vars node tools/coverage/collect.js || true
  }

  for engine in "${ENGINES[@]}"; do
    run_engine "$engine"
  done
fi

# Generate report using c8 (reads V8 coverage data)
echo ""
echo "=== Generating report ==="
npx c8 report \
  --temp-directory "$V8DIR" \
  --src . \
  --include 'components/*/src/**/*.js' \
  --include 'storages/**/*.js' \
  --exclude '**/test/**' \
  --exclude '**/node_modules/**' \
  --exclude 'storages/test/**' \
  --exclude 'storages/engines/*/test/**' \
  --exclude 'storages/datastores/*/test/**' \
  --exclude 'tools/**' \
  --reporter html --reporter text-summary --reporter json \
  --reports-dir coverage \
  --all

echo ""
echo "Report: coverage/index.html"
