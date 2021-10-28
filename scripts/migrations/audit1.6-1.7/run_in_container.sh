#!/bin/sh

cd /app/bin/scripts/migrations/audit1.6-1.7
npm install
node src/index.js /app/audit/ --config /app/conf/core.yml