#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root

# Set up assets
ASSETS_FOLDER="public_html/assets/"
if [[ ! -d $ASSETS_FOLDER ]]; then
  git clone --depth=1 --branch=master https://github.com/pryv/assets-open-pryv.io.git $ASSETS_FOLDER
  rm -rf $ASSETS_FOLDER/.git
  echo "Assets installed in ${ASSETS_FOLDER}"
else
  echo "Assets already installed skipping"
fi
