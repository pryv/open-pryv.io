FROM node:22-bookworm

WORKDIR /app

# System deps for native modules (better-sqlite3, sharp)
RUN apt-get update && \
    apt-get install -y python3 build-essential curl && \
    rm -rf /var/lib/apt/lists/*

# rqlite — mandatory since Plan 25 (rqlite is the only platform engine).
# master.js spawns rqlited directly; the binary must be inside the image.
ARG RQLITE_VERSION=9.4.5
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL -o /tmp/rqlite.tar.gz \
      "https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-${ARCH}.tar.gz" && \
    mkdir -p /app/var-pryv/rqlite-bin /app/var-pryv/rqlite-data && \
    tar xzf /tmp/rqlite.tar.gz -C /tmp --strip-components=1 && \
    cp /tmp/rqlited /app/var-pryv/rqlite-bin/ && \
    chmod +x /app/var-pryv/rqlite-bin/rqlited && \
    rm -rf /tmp/rqlite*

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

EXPOSE 3000

CMD ["node", "bin/master.js"]
