FROM node:24-bookworm

WORKDIR /app

# System deps for native modules (better-sqlite3, sharp)
RUN apt-get update && \
    apt-get install -y python3 build-essential curl && \
    rm -rf /var/lib/apt/lists/*

# rqlite — mandatory since Plan 25 (rqlite is the only platform engine).
# master.js spawns rqlited directly; the binary must be inside the image.
# Installed under /app/bin-ext/ (NOT /app/var-pryv/) so operators can bind-mount
# /app/var-pryv/rqlite-data without shadowing the baked-in binary.
ARG RQLITE_VERSION=9.4.5
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL -o /tmp/rqlite.tar.gz \
      "https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-${ARCH}.tar.gz" && \
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

# 3000: API. 4000: HFS (multi-worker). 3001: previews. 443: native HTTPS
# (when http.ssl.* set). 80: ACME HTTP-01 (DNS-01 is the default). 53/udp:
# embedded DNS (when dns.enabled). EXPOSE is informational only — Dokku and
# similar PaaS use it to know which container ports may be published.
EXPOSE 80 443 3000 3001 4000 53/udp

CMD ["node", "bin/master.js"]
