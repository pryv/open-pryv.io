ARG BUILD_HOST
ARG BUILD_VERSION
FROM ${BUILD_HOST}/pryvio/base:1.9.0
LABEL maintainer="Pryv<tech@pryv.com>"

ARG TARGET_DIR="/app/bin"

# copy all code to the target dir except files mentioned in .dockerignore
COPY . $TARGET_DIR
WORKDIR $TARGET_DIR

# add Python (needed to install node modules via node-gyp)
RUN apt-get update
RUN apt-get install -y python3

# install node modules here (sharp bundles libvips — no system image deps needed)
RUN npm ci --omit=dev --omit=optional

# remove build dependencies
RUN apt-get -y --purge autoremove python3
RUN apt-get remove -y --auto-remove autoconf automake curl build-essential git linux-libc-dev
RUN apt-get autoremove && apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# remove build scripts from the image
RUN rm -rf $TARGET_DIR/build

# config, data and log directories are mapped as Docker volumes
ENV NODE_ENV=production
ENV NODE_PATH=/app/bin/

# master.js replaces runit — manages API, HFS, and Previews workers
ENTRYPOINT ["node", "bin/master.js"]
CMD []
