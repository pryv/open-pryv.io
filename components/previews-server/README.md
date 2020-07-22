# Pryv previews server

Node.js / Express server supporting client apps with event previews (which are outside the scope of the main Pryv API).


## Usage

### Running the server

```bash
node src/server [options]
```

See [the root README](https://github.com/pryv/service-core/blob/master/README.md#about-configuration) to learn about configuration options.


### API

#### Event previews: `GET /events/{event-id}`

Returns a JPEG preview of the specified picture event. Authorization is the same as in the Pryv API (i.e. pass token in either `Authorization` header or `auth` query param). Accepted parameters:

- `w` | `width` (number): the desired preview width
- `h` | `height` (number): the desired preview height

Notes:

- Maintains the original's aspect ratio in all cases
- Adjusts the desired size to fit into one of the standard size squares (256x256, 512x512, 768x768, 1024x1024), while guaranteeing the returned size is not smaller than the desired size, except if the latter exceeds the max standard size
- Only `picture:attached` events are supported at the moment (if multiple files are attached the first one is used)
- Updates the corresponding attachment object with its `width` and `height` when initially generating the preview
- Trying to retrieve the preview for events of other types results in a 204 (No Content) response
- Permissions are enforced for the specified access token (you need a `"read"` access to the event to get its preview)
- Generated previews are cached (by default for a week); cached files are tracked via [extended file attributes](http://en.wikipedia.org/wiki/Extended_file_attributes) `event.modified` (to invalidate the cached version when the event is modified) and `last-accessed` (to remove cached files that aren't being used)


## Contribute

Make sure to check the root README first.


### Prerequisites

GraphicsMagick (Linux: `apt-get install graphicsmagick`, OSX (Homebrew): `brew install graphicsmagick`)


### Tests

- `yarn run test` (or `yarn test`) for quiet output
- `yarn run test-detailed` for detailed test specs and debug log output
- `yarn run test-profile` for profiling the tested server instance and opening the processed output with `tick-processor`
- `yarn run test-debug` is similar as `yarn run test-detailed` but in debug mode; it will wait for debuggers to be attached on both ports 5858 (the test process) and 5959 (the tested server process)
