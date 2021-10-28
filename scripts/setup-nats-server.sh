#!/bin/bash
# Install nats-server on linux machine
# This file is the duplicate of ./core/nats-server.sh file that consists of docker
# run commands to install nats-server

# check if nats-server is already installed and if no install it
# command -v nats-server should output /usr/local/bin/nats-server
VERSION="v2.3.4"
BASENAME="nats-server-$VERSION-linux-amd64"
FILENAME="$BASENAME.zip"
SOURCE_URL="https://github.com/nats-io/nats-server/releases/download/$VERSION/$FILENAME"

echo $SOURCE_URL
apt-get update && apt-get install -y unzip

mkdir -p ./nats-server && \
	  cd ./nats-server/ && 
	  curl -L -O $SOURCE_URL && 
	  unzip $FILENAME

#echo "24446c1be57d08ccc386a240a8ab5b78668e4db5d0c7878d548d3f95b90cb76b  $FILENAME" | sha256sum -c -