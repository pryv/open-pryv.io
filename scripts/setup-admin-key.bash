#!/bin/bash

SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)
cd $SCRIPT_FOLDER/.. # root

# Set up assets
CONFIG_FILE="./config.json"
set="abcdefghijklmonpqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
n=20
rand=""
for i in `seq 1 $n`; do
    char=${set:$RANDOM % ${#set}:1}
    rand+=$char
done
sed -i ".bak" "s/{ADMIN_ACCESS_KEY}/${rand}/g" $CONFIG_FILE 
rm "${CONFIG_FILE}.bak"


echo "Set new random key for admin"

