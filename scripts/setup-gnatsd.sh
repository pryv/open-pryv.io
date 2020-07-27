#!/bin/bash
# Install gnatsd on linux machine
# This file is the duplicate of ./core/gnatsd.sh file that consists of docker
# run commands to install gnatsd

# check if gnatsd is already installed and if no install it
# command -v gnatsd should output /usr/local/bin/gnatsd
VERSION="v1.0.4"
BASENAME="gnatsd-$VERSION-linux-amd64"
FILENAME="$BASENAME.zip"
SOURCE_URL="https://github.com/nats-io/gnatsd/releases/download/$VERSION/$FILENAME"

apt-get update && apt-get install -y unzip

mkdir -p ./gnatsd && \
	  cd ./gnatsd/ && 
	  curl -L -O $SOURCE_URL && 
	  unzip $FILENAME

echo "24446c1be57d08ccc386a240a8ab5b78668e4db5d0c7878d548d3f95b90cb76b  $FILENAME" | sha256sum -c -