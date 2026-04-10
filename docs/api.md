# API Concepts

## Events

Events are the primary units of content in Pryv. An event is a timestamped piece of typed data, possibly with one or more attached files, belonging to a given context. Depending on its type, an event can represent anything related to a particular time (picture, note, location, temperature measurement, etc.).

The API supports versioning, allowing to retrieve all previous versions of a specific event, necessary for audit activities. It is also possible for events to have a duration to represent a period instead of a single point in time, and the API includes specific functionality to deal with periods.

See also [standard event types](http://pryv.github.io/event-types/#directory).

|            |                                                              |
| ---------: | ------------------------------------------------------------ |
|       `id` | [identifier](http://pryv.github.io/reference/#data-structure-identifier) (readonly, unique) -  The identifier ([collision-resistant cuid](https://usecuid.org/)) for the event. Automatically generated if not set when creating the event. |
| `streamId` | [identifier](http://pryv.github.io/reference/#data-structure-identifier) - The id of the belonging stream. |
|     `time` | [timestamp](http://pryv.github.io/reference/#data-structure-timestamp) -  The event's time. For period events, this is the time the event started. |
| `duration` |                                                              |
|     `type` | string -  The type of the event. See the [event type directory](http://pryv.github.io/event-types/#directory) for a list of standard types. If the event is a high frequency series, the type starts with the prefix 'series:'. |
|  `content` | any (optional) -  The `type`-specific content of the event, if any. Leave empty if this event is a series event. |

## Series

Series are collections of homogenous data points. They should be used instead of events when the structure of the data doesn't change and you expect a high volume of data at possibly high speeds (O(1Hz)).

To store a data series in Pryv, you first create an event that has the type "series:X". The created series will store many values that all have the type X. Then you can start adding data to the series.

Each data point in a series has a `"timestamp"` field containing the timestamp for the data point. For [types](http://pryv.github.io/event-types/#directory) that store a single value (like "mass/kg") they contain a single additional field called `"value"`. Types that contain multiple fields (like "position/wgs84") will possibly have many fields, whose names can be inferred from the [type reference](http://pryv.github.io/event-types/#position). In the above example ("position/wgs84") there would be the fields `"latitude"`, `"longitude"` and possibly one of the optional fields `"altitude"`, `"horizontalAccuracy"`, `"verticalAccuracy"`, `"speed"`, `"bearing"`. Optional fields can either be given or not; missing values will be returned as null.

Series data can be encoded in transit in one of the following data formats.

### Format "flatJSON"

A single data point for the type "position/wgs84" would be encoded as follows:

~~~json
{
    "format": "flatJSON",
    "fields": ["timestamp", "latitude", "longitude", "altitude"],
    "points": [
        [1519314345, 10.2, 11.2, 500]
    ]
}
~~~

The `"fields"` array lists all the fields that you will be submitting, including the "timestamp" field.

The `"points"` array contains all the data points you'd like to submit. Each data point is represented by a simple array. This makes the bulk of the message (your data points) very space-efficient; values are encoded positionally. The first value corresponds to the first field, and so on.

Timestamps must be encoded as seconds (or fractions of seconds) since unix epoch.

You should submit multiple data points in a single API call to Pryv as follows (for example when sampling the height of a drone that is in rapid ascension):

~~~json
{
    "format": "flatJSON",
    "fields": ["timestamp", "latitude", "longitude", "altitude"],
    "points": [
        [1519314345, 10.2, 11.2, 500],
        [1519314346, 10.2, 11.2, 510],
        [1519314347, 10.2, 11.2, 520],
    ]
}
~~~

# API Endpoints

## Events

### Create Event

|      |                 |
| ---- | --------------- |
| id   | `events.create` |
| HTTP | POST /events    |

Records a new event. It is recommended that events recorded this way are completed events, i.e. either period events with a known duration or mark events. To start a running period event, use [Start period](http://pryv.github.io/reference/#methods-events-events-start) instead.

In addition to JSON, this request accepts standard multipart/form-data content to support the creation of event with attached files in a single request. When sending a multipart request, one content part must hold the JSON (application/json) for the new event and all other content parts must be the attached files.

To create an event that can hold high frequency series data, you will need to specify a `type` field that starts with the string "series:" and that ends with any valid Pryv data type, e.g: `"series:mass/kg"`. Leave the `content` field empty to create such a series - it will automatically be populated with meta data on the series.

#### PARAMETERS

The new event's data: see [Event](http://pryv.github.io/reference/#data-structure-event).

#### RESULT

`HTTP 201 Created`

|           |                                                              |
| --------- | ------------------------------------------------------------ |
| event     | [event](http://pryv.github.io/reference/#data-structure-event) - The created [event](http://pryv.github.io/reference/#data-structure-event). |
| stoppedId | [identifier](http://pryv.github.io/reference/#data-structure-identifier) - Only in `singleActivity` streams. If set, indicates the id of the previously running period event that was stopped as a consequence of inserting the new event. |

#### ERRORS

| Status | Error Code            |                                                              |
| ------ | --------------------- | ------------------------------------------------------------ |
| 400    | `"invalid-operation"` | The referenced stream is in the trash, and we prevent the recording of new events into trashed streams. |
| 400    | `"periods-overlap"`   | Only in `singleActivity` streams: the new event overlaps existing period events. The overlapped events' ids are listed as an array in the error's `data.overlappedIds`. |

## High Frequency Series

### Append Data to a Series Event

|      |                                  |
| ---- | -------------------------------- |
| HTTP | `POST /events/{event_id}/series` |

Appends new data to a series event.

The series data store will only store one set of values for any given timestamp. This means you can update existing data points by 'appending' new data with the original timestamps.

#### PARAMETERS

|          |                      |
| -------: | -------------------- |
| event_id | The id of the event. |

#### REQUEST BODY

Your data should be formatted as series data in the 'flatJSON' format.

#### RESULT

`HTTP 201 Created`

A successful append operation will respond with a body formatted as JSON ("application/json"). The general form of this body will look like this:

~~~json
{
    status: 'ok'
}
~~~

#### ERRORS

| Status | Error Code                    |                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| 400    | `"invalid-operation"`         | Not a series,                                                |
| 400    | `"invalid-request-structure"` | The request was malformed; please refer to the documentation above on how to construct an append request. |
| 403    | `"forbidden"`                 | The authorization provided to Pryv was not valid or doesn't have the access rights to store series data. |

## Query Series for Data


|      |                                 |
| ---- | ------------------------------- |
| HTTP | `GET /events/{event_id}/series` |

Queries data from a series event. Returns data in order of ascending timestamps between "from" and "to". Data is returned as input, no sampling or aggregation is performed. Data is returned in the "flatJSON" format.

#### PARAMETERS

|          |                                                              |
| -------: | ------------------------------------------------------------ |
| event_id | The id of the event.                                         |
| fromTime | timestamp (optional) – Only return data points later than this timestamp. If no value is given the query will return data starting at the earliest timestamp in the series. |
|   toTime | timestamp (optional) – Only return data points earlier than this timestamp. If no value is given the server returns only data that is in the past. |

When giving both "fromTime" and "toTime" to this method, the timestamp indicated by "fromTime" needs to be smaller or equal to the timestamp given by "toTime".

#### RESULT

`HTTP 200 Ok`

A successful query will respond with the data selected by the query from the series raw data. The answer will be a "flatJSON" formatted message ("application/json").

#### ERRORS

| Status | Error Code                    |                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| 400    | `"invalid-parameters-format"` | The query parameters are in the wrong format. Please give numeric timestamps to this method, where "from" is earlier than "to". |
| 401    | `"missing-header"`            | Access cannot be granted without a valid 'Authorization' header. |
| 403    | `"invalid-access-token"`      | Access denied; your token has insufficient permissions to access the given series. |
| 404    | `"unknown-resource"`          | No such series exists.                                       |
| 410    | `"resource-gone"`             | This resources has been removed .                             |

**Note 1** Since access permissions associated with a token are cached internally to speed up series access, you might get a `"invalid-access-token"` error even if you just adjusted the permissions on the token. There is a (configurable) delay during which the old access permissions will be retained.

## Append Data to Multiple Series (Batch)

|      |                    |
| ---- | ------------------ |
| HTTP | POST /series/batch |

Appends data to multiple series (stored in multiple events) in a single atomic operation. This is the fastest way to append data to Pryv; it allows transferring many data points in a single request.

For this operation to be successful, all of the following conditions must be fulfilled:

* The access token needs write permissions to all series identified by `"eventId"`.
* All events referred to must be series events (type starts with the string "series:").
* Fields identified in each individual message must match those specified by the type of the series event; there must be no duplicates.
* All the values in every data point must conform to the type specification. The data point matrix in every message must be rectangular.

If any part of the batch message is invalid, the entire batch is aborted and the returned result body identifies the error.

### PARAMETERS

No parameters must be given.

### REQUEST BODY

Request body should contain the data to be appended to the various series encoded as JSON text ("application/json"). The overall format of this message should be as follows:

~~~json
{
    "format": "seriesBatch",
    "data": [
    	// At least one BATCH_ENTRY.
    ]
}
~~~

A BATCH_ENTRY should be formatted as follows:

~~~json
{
    "eventId": "cjcrx6jy1000w8xpvjv9utxjx",
    "data": { // exactly one MESSAGE
        // data to store to the series identified by eventId.
    }
}
~~~

If we assume a "flatJSON" formatted data message, a full example would look like this:

~~~json
{
    "format": "seriesBatch",
    "data": [
    	{
    		"eventId": "cjcrx6jy1000w8xpvjv9utxjx",
		    "data": {
                "format": "flatJSON",
                "fields": ["timestamp", "latitude", "longitude", "altitude"],
                "points": [
                    [1519314345, 10.2, 11.2, 500],
                    [1519314346, 10.2, 11.2, 510],
                    [1519314347, 10.2, 11.2, 520],
                ]
    		}
		}
    ]
}
~~~

### RESULT

`HTTP 201 Created`

### RESPONSE BODY

Response body will contain a single field `"status"` with the value `"ok"`.

### ERRORS

In the case of an error in any part of the batch message, a HTTP status in the 40X range is returned.

| Status | Error Code                    |                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| 400    | `"invalid-request-structure"` | The request was malformed and could not be executed. The entire operation was aborted. |
| 403    | `"forbidden"`                 | The authorization provided to Pryv was not valid or doesn't have the access rights to store series data. |

**Debug Tip!** If you get a HTTP 400 status with the code `"invalid-request-structure"`, you should make sure that every element in the "seriesBatch" structure executes individually as part of a series append operation.
