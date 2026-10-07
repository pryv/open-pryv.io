#!/bin/sh
# Docker entrypoint dispatcher for pryvio/open-pryv.io.
#
# Modes:
#   docker run pryvio/open-pryv.io                              → normal boot (bin/master.js)
#   docker run pryvio/open-pryv.io init <config-path>           → interactive config wizard
#   docker run pryvio/open-pryv.io check-config <config-path>   → validate existing config, exit 0/1
#   docker run pryvio/open-pryv.io config-to-env <config-path>  → convert config to an env file (pure-ENV deployments)
#   docker run pryvio/open-pryv.io <anything-else…>             → pass through (e.g. `node --version`, `bash`)
#
# Privileges: the server (normal boot, or a pass-through `node bin/master.js …`
# as the wizard's run-pryv.sh issues) runs as the unprivileged `node` user
# (uid/gid 1000). The container starts as root so that this script can first
# hand the data directories to `node` (existing volumes were written by root),
# then it drops to `node`, keeping only CAP_NET_BIND_SERVICE so ports 53, 80
# and 443 still bind. Data directories:
#   /app/var-pryv /app/data /app/pryv/data /etc/pryv/tls /var/lib/pryv
#   + PRYV_OWNED_DIRS (space-separated, for data roots configured elsewhere)
# Only entries not already owned by `node` change, so boots after the first
# one only walk the trees. A container started with `--user` skips all of
# this. PRYV_RUN_AS_ROOT=true keeps the server on root (not recommended).
# The wizard modes and other pass-through commands keep running as the user
# the container was started with, because they write into operator mounts.
set -e

run_server () {
  if [ "$(id -u)" = "0" ] && [ "$PRYV_RUN_AS_ROOT" != "true" ]; then
    for dir in /app/var-pryv /app/data /app/pryv/data /etc/pryv/tls /var/lib/pryv $PRYV_OWNED_DIRS; do
      [ -d "$dir" ] || continue
      # Resolve a symlinked root so its target is handed over, then work
      # from inside each directory (-execdir) with `chown -h`: a link that
      # the server planted in its own data is changed, never followed.
      real=$(readlink -f "$dir")
      changed=$(find "$real" ! -user node -execdir chown -h node:node {} + -print | wc -l)
      [ "$changed" = "0" ] || echo "docker-entrypoint: $changed path(s) under $dir handed to user node"
    done
    # `--bootstrap` (joining a cluster) writes override-config.yml into the
    # image's config directory, which stays root-owned: prepare that one file.
    case " $* " in
      *" --bootstrap "*)
        case " $* " in
          *" --bootstrap-config-dir "*) ;;
          *)
            # 0600: it will carry the cluster secrets.
            touch /app/config/override-config.yml
            chmod 600 /app/config/override-config.yml
            chown node:node /app/config/override-config.yml
            ;;
        esac
        ;;
    esac
    # Keep the port-binding capability only when the container has it
    # (absent under `--cap-drop ALL`; then ports below 1024 need
    # net.ipv4.ip_unprivileged_port_start, which Docker sets to 0 by default
    # outside host networking).
    caps="--inh-caps=-all --ambient-caps=-all --bounding-set=-all"
    capbnd=$(sed -n 's/^CapBnd:[[:space:]]*//p' /proc/self/status)
    if [ $(( 0x$capbnd >> 10 & 1 )) = 1 ]; then
      caps="--inh-caps=-all,+net_bind_service --ambient-caps=-all,+net_bind_service --bounding-set=-all,+net_bind_service"
    fi
    export HOME=/home/node
    # shellcheck disable=SC2086
    exec setpriv --reuid=node --regid=node --init-groups --no-new-privs $caps -- "$@"
  fi
  [ "$(id -u)" != "0" ] || echo "docker-entrypoint: PRYV_RUN_AS_ROOT=true, the server runs as root"
  exec "$@"
}

case "$1" in
  init|check-config|config-to-env)
    cmd="$1"; shift
    exec node "bin/$cmd.js" "$@"
    ;;
  "")
    run_server node bin/master.js
    ;;
  node)
    case "$2" in
      bin/master.js|./bin/master.js|/app/bin/master.js) run_server "$@" ;;
      *) exec "$@" ;;
    esac
    ;;
  *)
    case "$*" in
      *bin/master.js*) [ "$(id -u)" != "0" ] || echo "docker-entrypoint: WARNING the server is started through '$1', so it keeps running as root; start it as 'node bin/master.js …' to run as user node" ;;
    esac
    exec "$@"
    ;;
esac
