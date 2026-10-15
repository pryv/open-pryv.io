# Base image digest-pinned for reproducibility + supply-chain integrity.
# The tag is a moving one (Docker Hub republishes it on every Node patch); the
# digest freezes the exact image. Re-pin deliberately (quarterly or on a
# security bump): docker buildx imagetools inspect node:24.18-trixie-slim
# (the 24.18 line, see below; or the registry manifest API) → update the sha256
# below + re-baseline (build with --no-cache locally: the apt upgrade layer is
# otherwise reused from an earlier build).
# Debian 13 (trixie) slim: Debian 12 (bookworm) left its remaining critical /
# high OS-package advisories unfixed (Grype on the 2.0.0-rc.53 image: 2
# critical, 72 high, none fixable), while trixie receives the fixes, which the
# `apt-get upgrade` below applies. Slim still apt-installs the build deps the
# native modules need below.
# Do NOT re-pin past Node 24.18.x until nodejs/node#65446 is fixed: better-sqlite3
# rebuilt against 24.19+ headers aborts the process on statement garbage collection.
# Pinned: node:24.18.1-trixie-slim (security release of the 24.18 line).
FROM node:24-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc

WORKDIR /app

# Debian security updates on top of the pinned base (the Node pin above keeps
# the base image itself from moving), then the build deps for the native
# modules (better-sqlite3, sharp) and curl for the rqlite download; all three
# are purged again below.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y python3 build-essential curl && \
    rm -rf /var/lib/apt/lists/*

# rqlite — mandatory (rqlite is the only platform engine in v2).
# master.js spawns rqlited directly; the binary must be inside the image.
# Installed under /app/bin-ext/ (NOT /app/var-pryv/) so operators can bind-mount
# /app/var-pryv/rqlite-data without shadowing the baked-in binary.
# The release tarball is integrity-checked (sha256) before extraction, so a
# tampered or MITM-able download fails the build instead of landing silently.
# Update both checksums when bumping RQLITE_VERSION (they are per-arch):
#   curl -fsSL <url> | sha256sum
ARG RQLITE_VERSION=10.6.0
ARG RQLITE_SHA256_amd64=cd64c28d672a702a6aeceab17a977ef11f3250634bd8931fb162bce4f6a84a41
ARG RQLITE_SHA256_arm64=f03cdb26e60f394796363817820f78804d2aa88a85930f7a0836c4a0d19d35c6
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) RQLITE_SHA256="$RQLITE_SHA256_amd64" ;; \
      arm64) RQLITE_SHA256="$RQLITE_SHA256_arm64" ;; \
      *) echo "unsupported architecture for rqlite: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/rqlite.tar.gz \
      "https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-${ARCH}.tar.gz" && \
    echo "${RQLITE_SHA256}  /tmp/rqlite.tar.gz" | sha256sum -c - && \
    mkdir -p /app/bin-ext /app/var-pryv/rqlite-data && \
    chown node:node /app/var-pryv /app/var-pryv/rqlite-data && \
    tar xzf /tmp/rqlite.tar.gz -C /tmp --strip-components=1 && \
    cp /tmp/rqlited /app/bin-ext/ && \
    chmod +x /app/bin-ext/rqlited && \
    rm -rf /tmp/rqlite*

# Declare /app/var-pryv/rqlite-data as a volume — the one and only path docker
# operators need to persist for PlatformDB state. /app/data is the conventional
# user data root (storages.engines.sqlite.path etc. in the operator's override),
# but its layout is deployment-specific so we leave it to the operator to mount
# explicitly.
VOLUME ["/app/var-pryv/rqlite-data"]

# Copy all source (workspaces need component package.json files for install)
COPY . .

# Install with workspaces (links components/* and storages into node_modules)
# --ignore-scripts avoids backloop.dev postinstall cert fetch failing in Docker;
# npm rebuild re-compiles all native addons (better-sqlite3, unix-dgram, etc.).
# --foreground-scripts runs those builds one at a time (and shows their output):
# in parallel, two node-gyp builds copy the Node headers into the same cache
# directory file by file, and a compile can read a half-written header (seen
# once on a tag build: unix-dgram failed with a libuv callback type mismatch).
RUN npm install --omit=dev --ignore-scripts && \
    npm rebuild --foreground-scripts

# Clean up build deps. npm (and npx) are needed only for the install above:
# the server never runs them, and the copy bundled with the Node base image
# carries its own dependencies (tar, undici, ...) with their own advisories.
RUN apt-get -y --purge autoremove python3 build-essential curl && \
    apt-get autoremove -y && apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

ENV NODE_ENV=production

# libuv's thread pool (default 4 threads per process) runs the password hashes
# (bcrypt), file system calls (attachments, uploads, SQLite files), DNS lookups
# (webhook targets) and compression. With 4 threads, a burst of logins keeps
# them all busy and every attachment read or webhook call waits behind it.
# 16 leaves threads for the other work; each idle thread costs little memory.
# Override with `-e UV_THREADPOOL_SIZE=<n>` (Node caps it at 1024).
ENV UV_THREADPOOL_SIZE=16

# Self-referential image tag — baked at build time, read at runtime by the
# install wizard so the generated run-pryv.sh / check-config.sh launchers
# default their PRYV_IMAGE to the same tag the container was pulled from.
# CI passes `--build-arg IMAGE_TAG=${{ github.ref_name }}` on tag pushes;
# local `docker build .` falls back to `dev` (a tag that doesn't exist on
# Docker Hub, so a wizard run from a local build surfaces the
# misconfiguration cleanly when the operator runs ./run-pryv.sh and docker
# can't pull it).
ARG IMAGE_TAG=dev
ENV PRYV_IMAGE_TAG=${IMAGE_TAG}

# Stamp the runtime version file from the released tag. `service/info.version`,
# the `API-Version` response header and `meta.apiVersion` all read `.api-version`
# (via components/middleware project_version); the committed file tracks the
# dev line, so without this a released image reports that dev value forever.
# Release builds pass the git tag as IMAGE_TAG and overwrite the file with it
# (leading `v` stripped, no trailing newline to match the checked-in format).
# Local/dev builds keep IMAGE_TAG=dev and leave the checked-in `.api-version`
# untouched, so a git checkout still advertises its honest dev-line value.
RUN if [ "${IMAGE_TAG}" != "dev" ]; then \
      printf '%s' "${IMAGE_TAG#v}" > /app/.api-version; \
    fi

# 3000: API. 4000: HFS (multi-worker). 3001: previews. 443: native HTTPS
# (when http.ssl.* set). 80: ACME HTTP-01 (DNS-01 is the default).
# 53/udp + 53/tcp: embedded DNS (when dns.active; RFC 7766 makes TCP
# mandatory). EXPOSE is informational only: Dokku and similar PaaS use it to
# know which container ports may be published.
EXPOSE 80 443 3000 3001 4000 53/udp 53/tcp

# The server runs as the image's unprivileged `node` user (uid/gid 1000). The
# image itself stays on root (no USER directive) because the entrypoint first
# hands the data directories to `node` (volumes from earlier images were
# written by root), then drops to `node` with only CAP_NET_BIND_SERVICE, via
# util-linux `setpriv`. The writable directories of a mount-less container are
# prepared here so a fresh container has nothing to change.
RUN command -v setpriv && \
    mkdir -p /app/data /etc/pryv/tls /var/lib/pryv && \
    chown -R node:node /app/data /app/var-pryv /etc/pryv/tls /var/lib/pryv

# Entry-point dispatcher: no args → normal master.js boot (as `node`);
# `init <path>` → interactive config wizard; `check-config <path>` → validate
# existing config; anything else → exec passthrough.
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD []
