/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const commonMeta = require('./methods/helpers/setCommonMeta');
const MultiStream = require('multistream');
const DrainStream = require('./methods/streams/DrainStream');
const ArraySerializationStream = require('./methods/streams/ArraySerializationStream');
const SingleObjectSerializationStream = require('./methods/streams/SingleObjectSerializationStream');
const async = require('async');

const { Transform } = require('stream');

const { DummyTracing } = require('tracing');

(async () => {
  await commonMeta.loadSettings();
})();
// Result object used to store API call response body while it is processed.
// In case of events.get call, it stores multiple streams in this.streamsArray.
// ie.: each Stream of data will be sent one after the other
// Otherwise, it works as a simple JS object.
//
// The result can be sent back to the caller using writeToHttpResponse or
// recovered as a JS object through the toObject() function.
//

class Result {
  _private;

  meta;
  // These are used by the various methods to store the result objects.
  // Never assume these are filled in...
  // Exercise to the reader: How can we get rid of this mixed bag of things?

  accesses;

  access;

  accessDeletion;

  accessDeletions;

  relatedDeletions;

  matchingAccess;

  mismatchingAccess;

  checkedPermissions;

  error;

  event;

  events;

  type;

  name;

  permissions;

  results;

  webhook;

  webhooks;

  webhookDeletion;

  auditLogs;
  constructor (params) {
    this._private = {
      init: false,
      first: true,
      arrayLimit: 10000,
      isStreamResult: false,
      streamsArray: [],
      onEndCallback: null,
      streamsConcatArrays: {},
      tracing: params?.tracing || new DummyTracing(),
      tracingId: null
    };
    this._private.tracingId = this._private.tracing.startSpan('apiResult');
    if (params && params.arrayLimit != null && params.arrayLimit > 0) {
      this._private.arrayLimit = params.arrayLimit;
    }
  }

  /**
   * @returns {void}
   */
  closeTracing () {
    this._private.tracing.finishSpan(this._private.tracingId);
  }

  // Array concat stream
  /**
   * @param {string} arrayName
   * @param {Readable} stream
   * @returns {void}
   */
  addToConcatArrayStream (arrayName, stream) {
    if (!this._private.streamsConcatArrays[arrayName]) {
      this._private.streamsConcatArrays[arrayName] = new StreamConcatArray(this._private.tracing, this._private.tracingId);
    }
    this._private.streamsConcatArrays[arrayName].add(stream);
    this._private.tracing.startSpan('addToConcatArrayStream:' + arrayName);
  }

  // Close
  /**
   * @param {string} arrayName
   * @returns {void}
   */
  closeConcatArrayStream (arrayName) {
    if (!this._private.streamsConcatArrays[arrayName]) {
      return;
    }
    this._private.tracing.finishSpan('addToConcatArrayStream:' + arrayName);
    this.addStream(arrayName, this._private.streamsConcatArrays[arrayName].getStream());
    this._private.streamsConcatArrays[arrayName].close();
  }

  // Pushes stream on the streamsArray stack, FIFO.
  //
  /**
   * @param {string} arrayName
   * @param {Readable} stream
   * @returns {void}
   */
  addStream (arrayName, stream, isArray = true) {
    this._private.isStreamResult = true;
    this._private.streamsArray.push({ name: arrayName, stream, isArray });
  }

  // Returns true if the Result holds any streams, false otherwise.
  //
  /**
   * @returns {boolean}
   */
  isStreamResult () {
    return this._private.isStreamResult;
  }

  // Execute the following when result has been fully sent
  // If already sent callback is called right away
  /**
   * @param {doneCallBack} callback
   * @returns {void}
   */
  onEnd (callback) {
    this._private.onEndCallback = callback;
  }

  // Sends the content of Result to the HttpResponse stream passed in parameters.
  //
  /**
   * @param {express$Response} res
   * @param {number} successCode
   * @returns {void}
   */
  writeToHttpResponse (res, successCode) {
    const onEndCallBack = this._private.onEndCallback;
    if (this.isStreamResult()) {
      const writeTracingId = this._private.tracing.startSpan('writeToHttpResponse', {}, this._private.tracingId);
      const stream = this.writeStreams(res, successCode);
      stream.on('close', function () {
        if (onEndCallBack) { onEndCallBack(); }
        this._private.tracing.finishSpan(writeTracingId);
        this.closeTracing();
      }.bind(this));
    } else {
      this.closeTracing();
      this.writeSingle(res, successCode);
      if (onEndCallBack) { onEndCallBack(); }
    }
  }

  /**
   * @param {express$Response} res
   * @param {number} successCode
   * @returns {any}
   */
  writeStreams (res, successCode) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.statusCode = successCode;
    const streamsArray = this._private.streamsArray;
    if (!this._private.isStreamResult) { throw new Error('AF: not a stream result.'); }
    if (streamsArray.length < 1) { throw new Error('streams array empty'); }

    const streams = [];
    for (let i = 0; i < streamsArray.length; i++) {
      const s = streamsArray[i];
      const serializedStream = s.stream.pipe(s.isArray ? new ArraySerializationStream(s.name) : new SingleObjectSerializationStream(s.name));
      streams.push(serializedStream);
    }

    return new MultiStream(streams)
      .pipe(new ResultStream(this._private.tracing, this._private.tracingId))
      .pipe(res);
  }

  /**
   * @param {express$Response} res
   * @param {number} successCode
   * @returns {void}
   */
  writeSingle (res, successCode) {
    delete this._private;
    res.status(successCode).json(commonMeta.setCommonMeta(this));
  }

  // Returns the content of the Result object in a JS object.
  // In case the Result contains a streamsArray, it will drain them in arrays.
  //
  /**
   * @param {ToObjectCallback} callback
   * @returns {void}
   */
  toObject (callback) {
    this.closeTracing();
    if (this.isStreamResult()) {
      this.toObjectStream(callback);
    } else {
      this.toObjectSingle(callback);
    }
  }

  /**
   * @param {ToObjectCallback} callback
   * @returns {void}
   */
  toObjectStream (callback) {
    const _private = this._private;
    const streamsArray = _private.streamsArray;
    const resultObj = {};
    async.forEachOfSeries(streamsArray, (elementDef, i, done) => {
      const drain = new DrainStream({ limit: _private.arrayLimit, isArray: elementDef.isArray }, (err, list) => {
        if (err) {
          return done(err);
        }
        resultObj[elementDef.name] = list;
        done();
      });
      elementDef.stream.pipe(drain);
    }, (err) => {
      if (err) {
        return callback(err);
      }
      callback(null, resultObj);
    });
  }

  /**
   * @param {ToObjectCallback} callback
   * @returns {void}
   */
  toObjectSingle (callback) {
    delete this._private;
    callback(null, this);
  }
}
// Stream that wraps the whole result in JSON curly braces before being sent to
// Http.response
/** @extends Transform */
class ResultStream extends Transform {
  isStart;
  tracing;
  tracingId;
  debugString;
  constructor (tracing, parentTracingId) {
    super({ writableObjectMode: true });
    this.isStart = true;
    this.tracing = tracing;
    this.tracingId = this.tracing.startSpan('resultStream', {}, parentTracingId);
    this.debugString = '';
  }

  /**
   * @returns {void}
   */
  _transform (data, encoding, callback) {
    if (this.isStart) {
      this.push('{');
      this.isStart = false;
      this.tracing.logForSpan(this.tracingId, { event: 'start' });
    }
    this.push(data);
    this.tracing.logForSpan(this.tracingId, { event: 'push' });
    callback();
  }

  // uncomment to debug
  // push (data) { this.debugString += data; super.push(data); }

  /**
   * @returns {void}
   */
  _flush (callback) {
    const thing = ' "meta": ' + JSON.stringify(commonMeta.setCommonMeta({}).meta);
    this.push(thing + '}');
    this.tracing.finishSpan('resultStream');

    if (this.debugString !== '') { console.log('***** RESULT DATA **********\n' + this.debugString + '\n*********************'); }
    callback();
  }
}
module.exports = Result;

class StreamConcatArray {
  streamsToAdd;

  nextFactoryCallBack;

  multistream;

  isClosed;

  tracing;

  tracingName;
  constructor (tracing, parentTracingId) {
    // holds pending stream not yet taken by
    this.streamsToAdd = [];
    this.nextFactoryCallBack = null;
    this.isClosed = false;
    this.tracing = tracing;
    this.tracingName = this.tracing.startSpan('streamConcat', {}, parentTracingId);
    const streamConcact = this;
    function factory (callback) {
      streamConcact.nextFactoryCallBack = callback;
      streamConcact._next();
    }
    this.multistream = new MultiStream(factory, { objectMode: true });
  }

  /**
   * @private
   * @returns {void}
   */
  _next () {
    if (!this.nextFactoryCallBack) { return; }
    if (this.streamsToAdd.length > 0) {
      const nextStream = this.streamsToAdd.shift();
      this.tracing.logForSpan(this.tracingName, { event: 'shiftStream' });
      this.nextFactoryCallBack(null, nextStream);
      this.nextFactoryCallBack = null;
      return;
    }
    if (this.isClosed) {
      this.tracing.finishSpan(this.tracingName);
      this.nextFactoryCallBack(null, null);
      this.nextFactoryCallBack = null;
    }
  }

  /**
   * @returns {any}
   */
  getStream () {
    return this.multistream;
  }

  /**
   * @param {Readable} readableStream
   * @returns {void}
   */
  add (readableStream) {
    this.tracing.logForSpan(this.tracingName, { event: 'addStream' });
    this.streamsToAdd.push(readableStream);
  }

  /**
   * @returns {void}
   */
  close () {
    this.isClosed = true;
    this._next();
  }
}

/**
 * @typedef {{
 *   arrayLimit?: number;
 *   tracing?: object;
 * }} ResultOptions
 */

/**
 * @typedef {{
 *   name: string;
 *   stream: Readable;
 * }} StreamDescriptor
 */

/**
 * @typedef {| {
 *       [x: string]: any;
 *     }
 *   | {
 *       [x: string]: Array<any>;
 *     }} APIResult
 */

/** @typedef {(err?: Error | null, res?: APIResult | null) => unknown} ToObjectCallback */

/** @typedef {() => unknown} doneCallBack */

/**
 * @typedef {{
 *   id: string;
 *   deleted: number;
 * }} itemDeletion
 */

/** @typedef {'read' | 'contribute' | 'manage'} PermissionLevel */

/** @typedef {'forbidden'} Setting */

/**
 * @typedef {| {
 *       streamId: string;
 *       level: PermissionLevel;
 *     }
 *   | {
 *       feature: string;
 *       setting: Setting;
 *     }} Permission
 */
