/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
const require = createRequire(import.meta.url);
const commonMeta = require('./methods/helpers/setCommonMeta.ts');
const MultiStream = require('multistream');
const DrainStream = require('./methods/streams/DrainStream.ts').default;
const ArraySerializationStream = require('./methods/streams/ArraySerializationStream.ts').default;
const SingleObjectSerializationStream = require('./methods/streams/SingleObjectSerializationStream.ts').default;

const { Transform, pipeline } = require('stream');
const { pipeThrough } = require('utils');
const { getLogger } = require('@pryv/boiler');

const logger = getLogger('result');

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

/**
 * Release every source the Result was handed, for the case where there is no
 * response left to pipe them into. Destroying a registered source reaches the
 * resource holder because every wrap on the way down now forwards destroy; for
 * a concat stream it also reaches the sources still queued behind the current
 * one (see ConcatMultiStream).
 */
function destroyRegisteredSources (streamsArray: StreamDescriptor[], extra: Readable[] = []): void {
  for (const s of streamsArray) {
    try { s.stream.destroy(); } catch (err) { logger.debug('failed to destroy a registered source', err); }
  }
  for (const s of extra) {
    try { s.destroy(); } catch (err) { logger.debug('failed to destroy a serialized stream', err); }
  }
}

class Result {
  _private!: ResultPrivate;

  meta?: unknown;
  // These are used by the various methods to store the result objects.
  // Never assume these are filled in...
  // Exercise to the reader: How can we get rid of this mixed bag of things?

  accesses?: unknown;

  access?: unknown;

  accessDeletion?: unknown;

  accessDeletions?: unknown;

  relatedDeletions?: unknown;

  matchingAccess?: unknown;

  mismatchingAccess?: unknown;

  checkedPermissions?: unknown;

  error?: unknown;

  event?: unknown;

  events?: unknown;

  type?: unknown;

  name?: unknown;

  permissions?: unknown;

  results?: unknown;

  webhook?: unknown;

  webhooks?: unknown;

  webhookDeletion?: unknown;

  [key: string]: unknown;
  constructor (params: ResultOptions | undefined) {
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

  closeTracing () {
    this._private.tracing.finishSpan(this._private.tracingId!);
  }

  // Array concat stream
  addToConcatArrayStream (arrayName: string, stream: Readable) {
    if (!this._private.streamsConcatArrays[arrayName]) {
      this._private.streamsConcatArrays[arrayName] = new StreamConcatArray(this._private.tracing, this._private.tracingId!);
    }
    this._private.streamsConcatArrays[arrayName].add(stream);
    this._private.tracing.startSpan('addToConcatArrayStream:' + arrayName);
  }

  // Close
  closeConcatArrayStream (arrayName: string) {
    if (!this._private.streamsConcatArrays[arrayName]) {
      return;
    }
    this._private.tracing.finishSpan('addToConcatArrayStream:' + arrayName);
    this.addStream(arrayName, this._private.streamsConcatArrays[arrayName].getStream());
    this._private.streamsConcatArrays[arrayName].close();
  }

  // Pushes stream on the streamsArray stack, FIFO.
  //
  addStream (arrayName: string, stream: Readable, isArray = true) {
    this._private.isStreamResult = true;
    this._private.streamsArray.push({ name: arrayName, stream, isArray });
  }

  // Returns true if the Result holds any streams, false otherwise.
  //
  isStreamResult () {
    return this._private.isStreamResult;
  }

  // Execute the following when result has been fully sent
  // If already sent callback is called right away
  onEnd (callback: () => void) {
    this._private.onEndCallback = callback;
  }

  // Sends the content of Result to the HttpResponse stream passed in parameters.
  //
  writeToHttpResponse (res: Response, successCode: number) {
    const rawOnEnd = this._private.onEndCallback;
    // The end-callback is async (it writes the audit record) and its result was
    // dropped on the floor, so a rejection inside it became an unhandled
    // rejection — which on current Node defaults takes the process down, after
    // the response has already been sent. Failures here must be logged, never
    // fatal: this runs on the success path of every audited request.
    const onEndCallBack = rawOnEnd == null
      ? null
      : () => {
          try {
            const returned = rawOnEnd() as unknown;
            if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
              Promise.resolve(returned).then(null, (err: unknown) => {
                logger.error('result onEnd callback failed', err);
              });
            }
          } catch (err) {
            logger.error('result onEnd callback threw', err);
          }
        };
    if (this.isStreamResult()) {
      // The client may already be gone before we get here. Attaching 'close' to
      // a destroyed response never fires, so the callback that AUDITS the call
      // would be lost, and building the chain would throw. Release the sources
      // and run the callback by hand instead.
      if (res.destroyed) {
        destroyRegisteredSources(this._private.streamsArray);
        if (onEndCallBack) { onEndCallBack(); }
        this.closeTracing();
        return;
      }
      const writeTracingId = this._private.tracing.startSpan('writeToHttpResponse', {}, this._private.tracingId!);
      const stream = this.writeStreams(res, successCode);
      stream.on('close', () => {
        if (onEndCallBack) { onEndCallBack(); }
        this._private.tracing.finishSpan(writeTracingId);
        this.closeTracing();
      });
    } else {
      this.closeTracing();
      this.writeSingle(res, successCode);
      if (onEndCallBack) { onEndCallBack(); }
    }
  }

  writeStreams (res: Response, successCode: number) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.statusCode = successCode;
    const streamsArray = this._private.streamsArray;
    if (!this._private.isStreamResult) { throw new Error('AF: not a stream result.'); }
    if (streamsArray.length < 1) { throw new Error('streams array empty'); }

    const streams: Readable[] = [];
    for (let i = 0; i < streamsArray.length; i++) {
      const s = streamsArray[i];
      const serializedStream = pipeThrough(s.stream, s.isArray ? new ArraySerializationStream(s.name) : new SingleObjectSerializationStream(s.name));
      streams.push(serializedStream);
    }

    // Fact 8: pipeline() onto an already-destroyed response throws
    // ERR_STREAM_UNABLE_TO_PIPE synchronously. writeToHttpResponse guards the
    // normal path; this keeps a direct caller from hitting it.
    if (res.destroyed) {
      destroyRegisteredSources(streamsArray, streams);
      return res;
    }

    const resultStream = new ResultStream(this._private.tracing, this._private.tracingId!);
    // The ONE place errors on this chain are reported. Inner wraps use a no-op
    // callback precisely because the same error arrives here.
    pipeline(new MultiStream(streams), resultStream, res, (err: NodeJS.ErrnoException | null) => {
      if (err == null) return;
      // A client that hangs up mid-response is ordinary traffic, not a fault.
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.debug('streamed response ended early (client went away)', err.code);
        return;
      }
      logger.warn('streamed response failed', err);
    });
    return res;
  }

  writeSingle (res: Response, successCode: number) {
    delete (this as Record<string, unknown>)._private;
    res.status(successCode).json(commonMeta.setCommonMeta(this));
  }

  // Returns the content of the Result object in a JS object.
  // In case the Result contains a streamsArray, it will drain them in arrays.
  //
  toObject (callback: ToObjectCallback) {
    this.closeTracing();
    if (this.isStreamResult()) {
      this.toObjectStream(callback);
    } else {
      this.toObjectSingle(callback);
    }
  }

  toObjectStream (callback: ToObjectCallback) {
    const _private = this._private;
    const streamsArray = _private.streamsArray;
    const resultObj: Record<string, unknown> = {};
    let i = 0;
    function nextElement (err?: unknown) {
      if (err) return callback(err as Error);
      if (i >= streamsArray.length) return callback(null, resultObj);
      const elementDef = streamsArray[i++];
      const drain = new DrainStream({ limit: _private.arrayLimit, isArray: elementDef.isArray }, (err: unknown, list: unknown) => {
        if (err) return nextElement(err);
        resultObj[elementDef.name] = list;
        nextElement();
      });
      // DrainStream reports through the callback it was given (including the
      // arrayLimit overflow), so the pipeline callback is a no-op here; what
      // matters is that hitting the limit destroys the chain and releases the
      // source instead of leaving it suspended.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      pipeline(elementDef.stream, drain, () => {});
    }
    nextElement();
  }

  toObjectSingle (callback: ToObjectCallback) {
    delete (this as Record<string, unknown>)._private;
    callback(null, this);
  }
}
// Stream that wraps the whole result in JSON curly braces before being sent to
// Http.response
/** @extends Transform */
class ResultStream extends Transform {
  isStart: boolean;
  tracing: Tracing;
  tracingId: string;
  debugString: string;
  constructor (tracing: Tracing, parentTracingId: string) {
    super({ writableObjectMode: true });
    this.isStart = true;
    this.tracing = tracing;
    this.tracingId = this.tracing.startSpan('resultStream', {}, parentTracingId);
    this.debugString = '';
  }

  _transform (data: unknown, encoding: BufferEncoding, callback: (err?: Error | null) => void) {
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

  _flush (callback: (err?: Error | null) => void) {
    const thing = ' "meta": ' + JSON.stringify(commonMeta.setCommonMeta({}).meta);
    this.push(thing + '}');
    this.tracing.finishSpan('resultStream');

    if (this.debugString !== '') { console.log('***** RESULT DATA **********\n' + this.debugString + '\n*********************'); }
    callback();
  }
}
export default Result;
export { Result };
/**
 * A factory-mode MultiStream that also tears down the streams still WAITING to
 * become current.
 *
 * multistream's own `_destroy` reaches `_current` only when it is driven by a
 * factory, but `events.get` across several stores queues the other stores'
 * streams behind the current one and they are already flowing — each can
 * already hold its own pooled client. Without this they would be abandoned on
 * an aborted response exactly like the pre-pipeline sources were.
 */
class ConcatMultiStream extends MultiStream {
  owner: StreamConcatArray;

  constructor (factory: unknown, options: unknown, owner: StreamConcatArray) {
    super(factory, options);
    this.owner = owner;
  }

  _destroy (err: Error | null, callback: (err?: Error | null) => void) {
    const pending = this.owner.streamsToAdd.splice(0);
    for (const stream of pending) {
      try { stream.destroy(); } catch (e) { logger.debug('failed to destroy a pending concat source', e); }
    }
    super._destroy(err, callback);
  }
}

class StreamConcatArray {
  streamsToAdd: Readable[];

  nextFactoryCallBack: ((err: unknown, stream: Readable | null) => void) | null;

  multistream: Readable;

  isClosed: boolean;

  tracing: Tracing;

  tracingName: string;
  constructor (tracing: Tracing, parentTracingId: string) {
    // holds pending stream not yet taken by
    this.streamsToAdd = [];
    this.nextFactoryCallBack = null;
    this.isClosed = false;
    this.tracing = tracing;
    this.tracingName = this.tracing.startSpan('streamConcat', {}, parentTracingId);
    const streamConcact = this;
    function factory (callback: (err: unknown, stream: Readable | null) => void) {
      streamConcact.nextFactoryCallBack = callback;
      streamConcact._next();
    }
    // `multistream` is untyped CJS, so extending it gives TypeScript a base of
    // `any` and the subclass does not structurally satisfy Readable. It is one
    // at runtime; the cast says so once, here.
    this.multistream = new ConcatMultiStream(factory, { objectMode: true }, this) as unknown as Readable;
  }

  /**
   * @private
   */
  _next () {
    if (!this.nextFactoryCallBack) { return; }
    if (this.streamsToAdd.length > 0) {
      const nextStream = this.streamsToAdd.shift()!;
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

  getStream () {
    return this.multistream;
  }

  add (readableStream: Readable) {
    this.tracing.logForSpan(this.tracingName, { event: 'addStream' });
    this.streamsToAdd.push(readableStream);
  }

  close () {
    this.isClosed = true;
    this._next();
  }
}

type ResultOptions = {
  arrayLimit?: number;
  tracing?: Tracing;
};
type StreamDescriptor = {
  name: string;
  stream: Readable;
  isArray: boolean;
};
type APIResult = Record<string, unknown>;

interface Tracing {
  startSpan: (name: string, opts?: Record<string, unknown>, parentId?: string) => string;
  finishSpan: (id: string) => void;
  logForSpan: (id: string, info: Record<string, unknown>) => void;
}

interface ResultPrivate {
  init: boolean;
  first: boolean;
  arrayLimit: number;
  isStreamResult: boolean;
  streamsArray: StreamDescriptor[];
  onEndCallback: (() => void) | null;
  streamsConcatArrays: Record<string, StreamConcatArray>;
  tracing: Tracing;
  tracingId: string | null;
}
type ToObjectCallback = (err?: Error | null, res?: APIResult | null) => unknown;
type doneCallBack = () => unknown;
type itemDeletion = {
  id: string;
  deleted: number;
};
