# High Frequency Series Server

High frequency series storage on InfluxDB.

**Make sure to read the project's main README first.**


## Details specific to this component

### Troubleshooting test failures

If some HFS tests are failing, saying that the actual amount of data in Influx is not as expected, e.g. :

```
  1) Storing data in a HF series
       POST /events/EVENT_ID/series
         bypassing authentication
           with auth success
             [N3PM] stores data into InfluxDB:

      AssertionError: expected 6 to equal 3
      + expected - actual

      -6
      +3

      at storeData.expect.then.then.response (test/acceptance/store_data.test.js:391:20)
      at <anonymous>
      at process._tickCallback (internal/process/next_tick.js:188:7)
```

you can try to delete your local Influx data before running the tests again:

```
cd ~/.influxdb
rm -r data
```


# License

[BSD-3-Clause](LICENSE)
