# Ferret DB Implementation

From version `1.9.1-open`

Open-Pryv.io supports [FerretDB](https://www.ferretdb.com) instead of MongoDB 

You simply need to start FerretDB instead of MongoDB and set the following parameters in the configuration file:

```yaml
database:
	isFerret: true
	authUser: 'username' # should match the user set on FerretDB
	authPassword: 'password' # should match the password set on FerretDB
```

### Exemple using Docker release of Ferret

Based on the informations which can be found on  [Docker release](https://docs.ferretdb.io/quickstart-guide/docker/)

Go to folder `ferretDB`

Edit the file `docker-compose.yml`  and set `username` and `password`

Start with: `docker compose up -d`

Initialize the database with (do just once) with: (set `username:password` to the correct values)

```bash
docker run --rm -it --network=ferretdb --entrypoint=mongosh mongo \
  "mongodb://username:password@ferretdb/ferretdb?authMechanism=PLAIN"
```

Run Api-Server

### Testing

1. Start FerretDB
2. Run `just test-ferret all`

### Notes & Feature requests

- Migration from MongoDB to FerretDB is still to be done. 
- A Docker version of Open-Pryv.io to be done



# License

[BSD-3-Clause](LICENSE)
