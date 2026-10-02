#!/bin/bash
# Backup/restore round trip: PG -> SQLite -> PG -> SQLite.
#
# Verifies that bin/backup.js produces engine-agnostic bundles that can be
# restored across engine boundaries without data loss.
#
# Steps:
#   Leg 1, PG: clean, start master, seed fixture, stop, backup A
#   Leg 2, SQLite: clean, restore A, backup B
#   Leg 3, PG: clean, restore B, backup C
#   Leg 4, SQLite: clean, restore C, backup D
#   Compare A, B, C and D with backup-rt-diff.js (counts, then content), and
#   require every seeded collection to be present in A.
#
# The fixture covers every collection a backup carries: events, streams,
# accesses (personal + app), profile, a webhook, an attachment and HF series.
#
# ⚑ Destructive for the local dev data: each leg runs `just clean-test-data`
# and the script temporarily replaces config/override-config.yml (restored on
# exit). Needs PostgreSQL and rqlited running, like the test matrices; their
# endpoints are read the way `just clean-test-data` reads them (environment
# overrides, then config/test-config.yml), so both address the same instances.
#
# Usage: just test-backup-roundtrip [options]
#    or: tools/backup-roundtrip/backup-roundtrip.sh [options]
#   --port N          Master HTTP port (default: 3000; must be free)
#   --keep            Keep the run directory (bundles, master log) on success
#   --backup-dir DIR  Parent directory for the run directory rt-<ts>
#                     (default: the system temp directory). Only rt-<ts> is
#                     ever deleted, never DIR itself.
# A failed run always keeps its run directory and prints where it is.

set -euo pipefail

# Script lives at <repo>/tools/backup-roundtrip/. Repo root is two dirs up.
SC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$SC/tools/backup-roundtrip"

# defaults
PORT=3000
KEEP=0
TS="$(date +%Y%m%d-%H%M%S)"
PARENT_DIR="${TMPDIR:-/tmp}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)       PORT="$2"; shift 2 ;;
    --keep)       KEEP=1; shift ;;
    --backup-dir) PARENT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

BACKUP_DIR="${PARENT_DIR%/}/rt-$TS"

TARGET="http://127.0.0.1:$PORT"
OVERRIDE="$SC/config/override-config.yml"
OVERRIDE_BAK=""
MASTER_PID=""
MASTER_LOG="$BACKUP_DIR/master.log"

# Same resolution as `just clean-test-data`: env overrides win, then
# config/test-config.yml, then the canonical ports.
TCFG="$SC/config/test-config.yml"
PG_HOST="${storages__engines__postgresql__host:-$(awk '/[[:space:]]postgresql:/{f=1} f&&/host:/{print $2; exit}' "$TCFG" 2>/dev/null)}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${storages__engines__postgresql__port:-$(awk '/[[:space:]]postgresql:/{f=1} f&&/port:/{print $2; exit}' "$TCFG" 2>/dev/null)}"
PG_PORT="${PG_PORT:-5432}"
RQLITE_URL="$(awk '/[[:space:]]rqlite:/{f=1} f&&/url:/{print $2; exit}' "$TCFG" 2>/dev/null)"
RQLITE_URL="${RQLITE_URL:-http://localhost:4001}"
if [ -n "${storages__engines__rqlite__host:-}${storages__engines__rqlite__port:-}" ]; then
  RQLITE_URL="http://${storages__engines__rqlite__host:-localhost}:${storages__engines__rqlite__port:-4001}"
fi

cleanup () {
  local status=$?
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
  if [ "$status" -ne 0 ]; then
    echo "✗ round trip failed (exit $status); run directory kept: $BACKUP_DIR"
  elif [ "$KEEP" = "0" ]; then
    rm -rf "$BACKUP_DIR"
  fi
}
port_is_free () {
  [ -z "$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]
}

# Pre-flight checks, before anything is created or changed.
if ! port_is_free; then
  echo "✗ port $PORT is already in use; stop that process or pass --port"
  exit 1
fi
if ! (exec 3<>"/dev/tcp/$PG_HOST/$PG_PORT") 2>/dev/null; then
  echo "✗ PostgreSQL is not reachable at $PG_HOST:$PG_PORT"
  exit 1
fi
if ! curl -s -o /dev/null "$RQLITE_URL/status"; then
  echo "✗ rqlited is not reachable at $RQLITE_URL"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
trap cleanup EXIT
# An interrupt must stop the run, not resume the next leg: exit, and let the
# EXIT trap clean up once.
trap 'exit 130' INT
trap 'exit 143' TERM

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
platform:
  # Fixed throwaway key (base64 of 32 bytes): every leg must hash PII with the
  # same key, or the restored platform index would not match the backup.
  piiHmacKey: cm91bmR0cmlwLXRlc3Qta2V5LW5vdC1hLXNlY3JldCE=
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
    postgresql:
      host: $PG_HOST
      port: $PG_PORT
    rqlite:
      url: $RQLITE_URL
      external: true
EOF
}

start_master () {
  if ! port_is_free; then
    echo "✗ port $PORT is in use before starting the master"
    exit 1
  fi
  cd "$SC"
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
      echo "  ✗ server did not become ready within ${timeout}s, see $MASTER_LOG"
      tail -40 "$MASTER_LOG" || true
      exit 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

# Seed the fixture user (see the header for what it contains).
# Progress goes to stderr; nothing is printed on stdout.
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
  TOKEN=$(echo "$REG_RES" | node -e "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{try{const m=/^https?:\/\/([^@]+)@/.exec(JSON.parse(s).apiEndpoint||'');console.log(m?m[1]:'')}catch{console.log('')}})")
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

  # One event with an attachment, so the attachment files travel too.
  local ATT_FILE="$BACKUP_DIR/rt-attachment.txt"
  printf 'round-trip attachment payload\n' > "$ATT_FILE"
  curl -sS -X POST "$TARGET/$USERNAME/events" \
    -H "Authorization: $TOKEN" \
    -F 'event={"streamIds":["rt-stream"],"type":"note/txt","content":"with attachment"};type=application/json' \
    -F "file=@$ATT_FILE" >/dev/null

  # Private profile data.
  curl -sS -X PUT "$TARGET/$USERNAME/profile/private" \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d '{"rtKey":"rt-value"}' >/dev/null

  # An app access (webhooks cannot be created with a personal token), then a
  # webhook owned by it. The URL is never called: no event is created after it.
  local APP_RES APP_TOKEN
  APP_RES=$(curl -sS -X POST "$TARGET/$USERNAME/accesses" \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d '{"name":"rt-app-access","permissions":[{"streamId":"rt-stream","level":"contribute"}]}')
  APP_TOKEN=$(echo "$APP_RES" | node -e "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{try{console.log(JSON.parse(s).access.token||'')}catch{console.log('')}})")
  if [ -z "$APP_TOKEN" ]; then
    echo "  ✗ failed to create the app access:" >&2
    echo "$APP_RES" >&2
    exit 1
  fi
  curl -sS -X POST "$TARGET/$USERNAME/webhooks" \
    -H "Authorization: $APP_TOKEN" -H 'Content-Type: application/json' \
    -d '{"url":"https://webhook.example.com/rt"}' >/dev/null

  # An HF series event with a few points.
  local SERIES_RES SERIES_ID
  SERIES_RES=$(curl -sS -X POST "$TARGET/$USERNAME/events" \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d '{"streamIds":["rt-stream"],"type":"series:mass/kg"}')
  SERIES_ID=$(echo "$SERIES_RES" | node -e "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{try{console.log(JSON.parse(s).event.id||'')}catch{console.log('')}})")
  if [ -z "$SERIES_ID" ]; then
    echo "  ✗ failed to create the series event:" >&2
    echo "$SERIES_RES" >&2
    exit 1
  fi
  local POINTS_RES
  POINTS_RES=$(curl -sS -X POST "$TARGET/$USERNAME/events/$SERIES_ID/series" \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    -d '{"format":"flatJSON","fields":["deltaTime","value"],"points":[[0,70.1],[60,70.2],[120,70.3]]}')
  if ! echo "$POINTS_RES" | grep -q '"status":"ok"'; then
    echo "  ✗ failed to write series points:" >&2
    echo "$POINTS_RES" >&2
    exit 1
  fi

  echo "  ✓ seeded user=$USERNAME: 11 notes (1 with attachment), profile, app access + webhook, series event with 3 points" >&2
}

run_leg () {
  local LEG_NAME="$1"
  local ENGINE="$2"
  local ACTION="$3"  # seed | restore <BUNDLE>
  local OUT_BUNDLE="$4"
  shift 4

  echo ""
  echo "──────────────────────────────────────────────"
  echo " Leg $LEG_NAME: engine=$ENGINE  action=$ACTION  out=$OUT_BUNDLE"
  echo "──────────────────────────────────────────────"

  write_override "$ENGINE"

  echo "[leg] cleaning test data"
  cd "$SC"
  if ! just clean-test-data > "$BACKUP_DIR/clean-test-data.log" 2>&1; then
    echo "  ✗ just clean-test-data failed:"; tail -20 "$BACKUP_DIR/clean-test-data.log"; exit 1
  fi
  cd "$SC"

  if [ "$ACTION" = "seed" ]; then
    echo "[leg] starting master"
    start_master
    wait_for_ready
    echo "[leg] seeding fixture user"
    seed_fixture
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
node "$SCRIPT_DIR/backup-rt-diff.js" \
  --require-nonzero events,streams,accesses,profile,webhooks,attachments,series,audit \
  "$BACKUP_DIR/A" "$BACKUP_DIR/B" "$BACKUP_DIR/C" "$BACKUP_DIR/D"

echo ""
echo "✓ round-trip complete"
if [ "$KEEP" = "1" ]; then
  echo "  bundles preserved at $BACKUP_DIR"
fi
