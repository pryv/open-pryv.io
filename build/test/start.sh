SCRIPT_FOLDER=$(cd $(dirname "$0"); pwd)

export PRYV_CONF_ROOT=$SCRIPT_FOLDER

# Create default directories
mkdir -p ${PRYV_CONF_ROOT}/pryv/mongodb/backup
mkdir -p ${PRYV_CONF_ROOT}/pryv/mongodb/log
mkdir -p ${PRYV_CONF_ROOT}/pryv/mongodb/data
mkdir -p ${PRYV_CONF_ROOT}/pryv/core/log
mkdir -p ${PRYV_CONF_ROOT}/pryv/core/data
mkdir -p ${PRYV_CONF_ROOT}/pryv/influxdb/log
mkdir -p ${PRYV_CONF_ROOT}/pryv/influxdb/data
sudo chown -R 9999:9999 \
${PRYV_CONF_ROOT}/pryv/influxdb/data \
${PRYV_CONF_ROOT}/pryv/core/data \
${PRYV_CONF_ROOT}/pryv/influxdb/log \
${PRYV_CONF_ROOT}/pryv/core/log

HOSTNAME=l.backloop.dev docker-compose -f ${PRYV_CONF_ROOT}/pryv.yml up
