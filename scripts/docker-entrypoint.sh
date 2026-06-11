#!/bin/sh
# Docker entrypoint dispatcher for pryvio/open-pryv.io.
#
# Modes:
#   docker run pryvio/open-pryv.io                              → normal boot (bin/master.js)
#   docker run pryvio/open-pryv.io init <config-path>           → interactive config wizard
#   docker run pryvio/open-pryv.io check-config <config-path>   → validate existing config, exit 0/1
#   docker run pryvio/open-pryv.io config-to-env <config-path>  → convert config to an env file (pure-ENV deployments)
#   docker run pryvio/open-pryv.io <anything-else…>             → pass through (e.g. `node --version`, `bash`)
set -e

case "$1" in
  init|check-config|config-to-env)
    cmd="$1"; shift
    exec node "bin/$cmd.js" "$@"
    ;;
  "")
    exec node bin/master.js
    ;;
  *)
    exec "$@"
    ;;
esac
