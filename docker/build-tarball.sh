#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER

mkdir -p ./rec.la-certificates
echo "run ../scripts/update-recla-certificates to download rec.la ssl certs" > ./rec.la-certificates/README
cp -rf ../public_html/ ./public_html

cp ../scripts/update-recla-certificates ./scripts

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
  ./scripts/ \

rm -r ./rec.la-certificates
rm -r ./public_html
