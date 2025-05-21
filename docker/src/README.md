# Dockerized Open Pryv.io

This archive contains the necessary files to serve as base directory and run Open-Pryv.io from Docker

*Prerequisites*:

- [Docker v19.03](https://docs.docker.com/engine/install/)
- [Docker-compose v1.26](https://docs.docker.com/compose/install/)

## Configuration 

Docker containerized version of Open-Pryv.io uses only `./config/api.yml` keep a backup of it!

You must change the `auth:adminAccessKey` to a strong random key. 

For other settings refer to [Config info on main Open-Pryv.io README](https://github.com/pryv/open-pryv.io#config)

### Port

Note that `http:port` and `http:settings` of `./config/api.yml` are ignored and overriden by docker package.
You may change the port exposed by Docker from the file `./env_config`

### SSL 

**backloop.dev** Loop back
You can run dockerized version in local by replacing `./config/api.yml` with `./config/api-backloop.yml`.
Then the api will be accessible **From the local machine only** on `https://my-computer.backloop.dev:3000`

**Own certificate**
Create a `secrets` folder in `./configs/` with your `key.pem`, `cert.pem` and optional `ca.pem` files. 
The `http:ssl:xFile` settings should point to `/app/configs/secrets/xxx.pem` files.

Make sure to adapt the `dnsLess:publicUrl` with `https://` an the correct hostname. 

## Backup

1. First stop **open-pryv-api** only with `docker stop open-pryv-api`
2. The following command will backup the database in `${PRYV_BASE}/var-pryv/mongo/backup` => `docker exec -t open-pryv-mongo mongodump -d pryv-node -o /data/backup/` 
3. Then you can stop other containers with `./stop.sh` 

You can backup all `${PRYV_BASE}/var-pryv` as it will contains the operation data. Make sure you can preserve permissons. 
Eventually delete the content of `${PRYV_BASE}/var-pryv/mongo/db/` in case you plan a mongodb migration 

## Restore 

On a fresh install (never started) 

1. Copy the content of backup to `${PRYV_BASE}/var-pryv`
2. Start the service with `./start.sh`
3. Restore mongodb data with `docker exec -t open-pryv-mongo mongorestore /data/backup/`



## License

[BSD-3-Clause](LICENSE)


# License

[BSD-3-Clause](LICENSE)
