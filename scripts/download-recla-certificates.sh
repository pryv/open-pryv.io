#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root

# download rec.la certificates
CERTIFICATED_FOLDER="./rec.la-certificates"
if [ ! -d $CERTIFICATED_FOLDER ]; then
	echo "Downloading default certificates to $CERTIFICATED_FOLDER"
	mkdir $CERTIFICATED_FOLDER
    git clone --branch=master https://github.com/pryv/rec-la.git $CERTIFICATED_FOLDER
else
    echo "Refreshing default certificates in $CERTIFICATED_FOLDER"
    CURRENT_DIR=$(pwd)
    cd $CERTIFICATED_FOLDER # go to the certificates folder
    echo $(pwd)
    # download the newest version
    git pull
    # come back to the main dir
    cd $CURRENT_DIR
fi