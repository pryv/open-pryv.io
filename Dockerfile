# Base image digest-pinned for reproducibility + supply-chain integrity.
# `node:24-bookworm` is a moving tag (Docker Hub republishes it on every Node
# patch); the digest freezes the exact image. Re-pin deliberately (quarterly
# or on a security bump): docker buildx imagetools inspect node:24-bookworm
# (or the registry manifest API) → update the sha256 below + re-baseline.
FROM node:24-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059

WORKDIR /app

# System deps for native modules (better-sqlite3, sharp)
RUN apt-get update && \
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
ARG RQLITE_VERSION=9.4.5
ARG RQLITE_SHA256_amd64=96c82652929085af49d1ebc8d14891a02105d063be7eee25a9bb90af4e5f9f3b
ARG RQLITE_SHA256_arm64=5fe34f9c610aaa7ad631e8d7d66e0302cc6b7c799be5b30996a52deeaa542a7b
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
    tar xzf /tmp/rqlite.tar.gz -C /tmp --strip-components=1 && \
    cp /tmp/rqlited /app/bin-ext/ && \
    chmod +x /app/bin-ext/rqlited && \
    rm -rf /tmp/rqlite*

# Declare /app/var-pryv/rqlite-data as a volume — the one and only path docker
# operators need to persist for PlatformDB state. /app/data is also persistent
# (PRYV_DATADIR) but its layout is deployment-specific so we leave it to the
# operator to mount explicitly.
VOLUME ["/app/var-pryv/rqlite-data"]

# Copy all source (workspaces need component package.json files for install)
COPY . .

# Install with workspaces (links components/* and storages into node_modules)
# --ignore-scripts avoids backloop.dev postinstall cert fetch failing in Docker;
# npm rebuild re-compiles all native addons (better-sqlite3, unix-dgram, etc.)
RUN npm install --omit=dev --ignore-scripts && \
    npm rebuild

# Clean up build deps
RUN apt-get -y --purge autoremove python3 build-essential && \
    apt-get autoremove -y && apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV NODE_ENV=production

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

# 3000: API. 4000: HFS (multi-worker). 3001: previews. 443: native HTTPS
# (when http.ssl.* set). 80: ACME HTTP-01 (DNS-01 is the default). 53/udp:
# embedded DNS (when dns.enabled). EXPOSE is informational only — Dokku and
# similar PaaS use it to know which container ports may be published.
EXPOSE 80 443 3000 3001 4000 53/udp

# Entry-point dispatcher: no args → normal master.js boot;
# `init <path>` → interactive config wizard; `check-config <path>` → validate
# existing config; anything else → exec passthrough.
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD []
