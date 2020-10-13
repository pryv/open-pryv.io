#! /bin/sh

docker exec -t open-pryv-mongo mongodump -d pryv-node -o /data/backup/
