# HOWTO

1. Mount `/var/log/pryv/audit/pryvio_core/` to `/app/audit` in pryvio_core docker container

```yaml
 core:
    image: "docker.io/pryvio/core:1.7.0-rc10"
    container_name: pryvio_core
    networks:
      - frontend
      - backend
    volumes:
      - ${PRYV_CONF_ROOT}/pryv/core/conf/:/app/conf/:ro
      - ${PRYV_CONF_ROOT}/pryv/core/data/:/app/data/
      - ${PRYV_CONF_ROOT}/pryv/core/log/:/app/log/
      - /dev/log:/dev/log # for audit log
      - /var/log/pryv/audit/pryvio_core/:/app/audit
```

2. Restart Pryvio core docker container: `docker restart pryvio_core`
3. Run the following commands: `docker exec -ti pryvio_core /app/bin/scripts/migrations/audit1.6-1.7/run_in_container.sh`


# License

[BSD-3-Clause](LICENSE)
