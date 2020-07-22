/**
 * JSON Schema specification of methods data for followed slices.
 */

var Action = require('./Action'),
    followedSlice = require('./followedSlice'),
    itemDeletion = require('./itemDeletion'),
    object = require('./helpers').object,
    array = require('./helpers').array,
    string = require('./helpers').string,
    _ = require('lodash');

module.exports = {

  get: {
    params: object({}, {id: 'followedSlices.get'}),
    result: object({
      'followedSlices': array(followedSlice(Action.READ))
    }, {
      required: [ 'followedSlices' ]
    })
  },

  create: {
    params: _.extend(followedSlice(Action.CREATE)),
    result: object({
      'followedSlice': _.extend(followedSlice(Action.READ))
    }, {
      required: [ 'followedSlice' ]
    })
  },

  update: {
    params: object({
      // in path for HTTP requests
      'id': string(),
      // = body of HTTP requests
      'update': _.extend(followedSlice(Action.UPDATE))
    }, {
      id: 'followedSlices.update',
      required: [ 'id', 'update' ]
    }),
    result: object({
      'followedSlice': _.extend(followedSlice(Action.READ))
    }, {
      required: [ 'followedSlice' ]
    })
  },

  del: {
    params: object({
      // in path for HTTP requests
      'id': string()
    }, {
      id: 'followedSlices.delete',
      required: [ 'id' ]
    }),
    result: object({followedSliceDeletion: itemDeletion}, {
      required: ['followedSliceDeletion'],
      additionalProperties: false
    })
  }

};
