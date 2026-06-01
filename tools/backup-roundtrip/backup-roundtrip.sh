#!/bin/bash
# Backup/restore round-trip: PG → SQLite → PG → SQLite.
#
# Verifies that bin/backup.js produces engine-agnostic bundles that can
# be restored across engine boundaries without data loss. Built from
# the perf-vs.sh start/stop+engine-swap pattern.
#
# Steps:
#   Leg 1 — PG: clean → start master → seed fixture → stop → backup A
#   Leg 2 — SQLite: clean → restore A → backup B
#   Leg 3 — PG: clean → restore B → backup C
#   Leg 4 — SQLite: clean → restore C → backup D
#   Compare A vs B vs C vs D via backup-rt-diff.js
#
# Usage: _local/scripts/backup-roundtrip.sh [options]
#   --port N        Master HTTP port (default: 3000)
#   --keep          Don't clean up backup dirs / override-config at end
#   --backup-dir DIR  Where backup dirs are written (default: /tmp/rt-<ts>)

set -euo pipefail

# Script lives at <repo>/tools/backup-roundtrip/. Repo root is two dirs up.
SC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$SC/tools/backup-roundtrip"

# defaults
PORT=3000
KEEP=0
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)       PORT="$2"; shift 2 ;;
    --keep)       KEEP=1; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[ -z "$BACKUP_DIR" ] && BACKUP_DIR="/tmp/rt-$TS"
mkdir -p "$BACKUP_DIR"

TARGET="http://127.0.0.1:$PORT"
OVERRIDE="$SC/config/override-config.yml"
OVERRIDE_BAK=""
MASTER_PID=""
MASTER_LOG="/tmp/rt-master-$TS.log"

cleanup () {
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    echo "[cleanup] stopping master pid=$MASTER_PID"
    kill -TERM "$MASTER_PID" 2>/dev/null || true
    sleep 3
    kill -KILL "$MASTER_PID" 2>/dev/null || true
  fi
  if [ -n "$OVERRIDE_BAK" ] && [ -f "$OVERRIDE_BAK" ]; then
    mv "$OVERRIDE_BAK" "$OVERRIDE"
  elif [ -z "$OVERRIDE_BAK" ] && [ -f "$OVERRIDE" ]; then
    rm -f "$OVERRIDE"
  fi
  if [ "$KEEP" = "0" ]; then
    rm -rf "$BACKUP_DIR"
  fi
}
trap cleanup EXIT INT TERM

if [ -f "$OVERRIDE" ]; then
  OVERRIDE_BAK="$OVERRIDE.bak.rt-$TS"
  cp "$OVERRIDE" "$OVERRIDE_BAK"
fi

write_override () {
  local ENGINE="$1"
  cat > "$OVERRIDE" <<EOF
http:
  port: $PORT
  ip: 127.0.0.1
service:
  name: Pryv Backup-Roundtrip
  serial: rt-$TS
  home: http://127.0.0.1:$PORT
  support: http://127.0.0.1:$PORT
  terms: http://127.0.0.1:$PORT
  eventTypes: file://test/service-info.json
  api: http://127.0.0.1:$PORT/{username}/
  register: http://127.0.0.1:$PORT/reg/
auth:
  adminAccessKey: rt-admin
  filesReadTokenSecret: rt-files-secret
  passwordResetPageURL: http://127.0.0.1:$PORT/reset
  trustedApps: "*@*"
dnsLess:
  isActive: true
  publicUrl: http://127.0.0.1:$PORT/
logs:
  console:
    active: true
    level: warn
services:
  email:
    enabled:
      welcome: false
      resetPassword: false
storages:
  base:
    engine: $ENGINE
  series:
    engine: $ENGINE
  engines:
    sqlite:
      path: $SC/var-pryv/users
    filesystem:
      attachmentsDirPath: $SC/var-pryv/attachments
      previewsDirPath: $SC/var-pryv/previews
    rqlite:
      url: http://localhost:4001
      external: true
EOF
}

stop_existing_master () {
  local existing
  existing="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    kill -TERM $existing 2>/dev/null || true
    sleep 3
    kill -KILL $existing 2>/dev/null || true
  fi
}

start_master () {
  cd "$SC"
  : > "$MASTER_LOG"
  NODE_ENV=production node bin/master.js --config "$OVERRIDE" >> "$MASTER_LOG" 2>&1 &
  MASTER_PID=$!
  cd "$SC"
}

stop_master () {
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    kill -TERM "$MASTER_PID" 2>/dev/null || true
    local waited=0
    while kill -0 "$MASTER_PID" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
      [ "$waited" -ge 10 ] && { kill -KILL "$MASTER_PID" 2>/dev/null || true; break; }
    done
  fi
  MASTER_PID=""
}

wait_for_ready () {
  local timeout=60
  local elapsed=0
  while ! curl -s -o /dev/null "$TARGET/" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "  ✗ server did not become ready within ${timeout}s — see $MASTER_LOG"
      tail -40 "$MASTER_LOG" || true
      exit 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

# Seed a small fixture: 1 user with N events.
# Returns the username + personal token via stdout (last two lines).
seed_fixture () {
  local ADMIN="rt-admin"
  local USERNAME="rtuser$(date +%s | tail -c 7)"
  local PASSWORD="rt-secret-pass"
  local EMAIL="${USERNAME}@example.com"

  # Register: response carries apiEndpoint with embedded personal token.
  # Sample: "apiEndpoint":"http://<token>@127.0.0.1:3000/<username>/"
  local REG_RES
  REG_RES=$(curl -sS -X POST "$TARGET/reg/users" \
    -H "Authorization: $ADMIN" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"email\":\"$EMAIL\",\"appId\":\"rt-app\",\"languageCode\":\"en\",\"invitationtoken\":\"enjoy\",\"referer\":\"none\"}")
  local TOKEN
  TOKEN=$(echo "$REG_RES" | python3 -c "import sys,json,re;m=re.match(r'https?://([^@]+)@',json.load(sys.stdin)['apiEndpoint']);print(m.group(1) if m else '')")
  if [ -z "$TOKEN" ]; then
    echo "  ✗ failed to extract token from register response:" >&2
    echo "$REG_RES" >&2
    exit 1
  fi

  # Create a stream
  curl -sS -X POST "$TARGET/$USERNAME/streams" \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d '{"id":"rt-stream","name":"Round-trip stream"}' >/dev/null

  # Create 10 events
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS -X POST "$TARGET/$USERNAME/events" \
      -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"streamIds\":[\"rt-stream\"],\"type\":\"note/txt\",\"content\":\"event-$i\"}" >/dev/null
  done

  echo "  ✓ seeded user=$USERNAME with 10 events on rt-stream" >&2
  echo "$USERNAME"
  echo "$TOKEN"
}

run_leg () {
  local LEG_NAME="$1"
  local ENGINE="$2"
  local ACTION="$3"  # seed | restore <BUNDLE>
  local OUT_BUNDLE="$4"
  shift 4

  echo ""
  echo "──────────────────────────────────────────────"
  echo " Leg $LEG_NAME — engine=$ENGINE  action=$ACTION  out=$OUT_BUNDLE"
  echo "──────────────────────────────────────────────"

  stop_existing_master
  MASTER_PID=""

  write_override "$ENGINE"

  echo "[leg] cleaning test data"
  cd "$SC"
  just clean-test-data > /dev/null 2>&1
  cd "$SC"

  if [ "$ACTION" = "seed" ]; then
    echo "[leg] starting master"
    start_master
    wait_for_ready
    echo "[leg] seeding fixture user"
    seed_fixture > /tmp/rt-fixture-$TS.txt
    stop_master
  elif [ "${ACTION%% *}" = "restore" ]; then
    local SRC="${ACTION#restore }"
    echo "[leg] restore from $SRC (no master needed; bin/backup.js standalone)"
    cd "$SC"
    NODE_ENV=production node bin/backup.js --restore "$SRC" >> "$MASTER_LOG" 2>&1
    cd "$SC"
  fi

  echo "[leg] backup → $OUT_BUNDLE"
  cd "$SC"
  NODE_ENV=production node bin/backup.js --output "$OUT_BUNDLE" >> "$MASTER_LOG" 2>&1
  cd "$SC"
  echo "  ✓ backup written; manifest: $(ls "$OUT_BUNDLE"/manifest.json 2>/dev/null && echo OK || echo MISSING)"
}

# ============================================================================
# Round trip
# ============================================================================

echo "╔══════════════════════════════════════════════╗"
echo "║  Backup / Restore Round Trip                  ║"
echo "║  PG → SQLite → PG → SQLite                    ║"
echo "║  Backup dir: $BACKUP_DIR"
echo "╚══════════════════════════════════════════════╝"

run_leg "1" "postgresql" "seed"                            "$BACKUP_DIR/A"
run_leg "2" "sqlite"     "restore $BACKUP_DIR/A"           "$BACKUP_DIR/B"
run_leg "3" "postgresql" "restore $BACKUP_DIR/B"           "$BACKUP_DIR/C"
run_leg "4" "sqlite"     "restore $BACKUP_DIR/C"           "$BACKUP_DIR/D"

echo ""
echo "──────────────────────────────────────────────"
echo " Diff: A vs B vs C vs D"
echo "──────────────────────────────────────────────"
node "$SCRIPT_DIR/backup-rt-diff.js" "$BACKUP_DIR/A" "$BACKUP_DIR/B" "$BACKUP_DIR/C" "$BACKUP_DIR/D"

echo ""
echo "✓ round-trip complete"
[ "$KEEP" = "1" ] && echo "  bundles preserved at $BACKUP_DIR"
