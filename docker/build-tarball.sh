#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER

mkdir -p ./rec.la-certificates
mkdir -p ./public_html
curl -o ./rec.la-certificates/rec.la-key.pem https://www.rec.la/rec.la-key.pem
curl -o ./rec.la-certificates/rec.la-bundle.crt https://www.rec.la/rec.la-bundle.crt
cp -af ../public_html/* ./public_html

tar czfv dockerized-open-pryv.io.tgz \
  ./local/dockerized-config.yml \
  ./local/dockerized-service-mail-config.hjson \
  ./local/nginx-templates/ \
  ./local/dhparam.pem \
  ./local/docker-compose.with-ssl.yml \
  ./production-no-ssl \
  ./production-with-ssl \
  ./README.md \
  ./rec.la-certificates \
  ./public_html \
  ./scripts/backup-database-docker.sh \
  ./scripts/restore-database-docker.sh \
  ./scripts/backup-attachments-docker.sh \
  ./scripts/restore-attachments-docker.sh \
  
rm -r ./rec.la-certificates
rm -r ./public_html