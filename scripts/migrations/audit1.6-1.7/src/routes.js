/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const routes = [
  {
    methodId: 'service.info',
    path: '/reg/service/info',
    method: 'get'
  },
  {
    methodId: 'auth.delete',
    path: '/users/:username',
    method: 'delete'
  },
  { methodId: 'auth.register', path: '/users', method: 'post' },
  { methodId: 'auth.register', path: '/reg/user', method: 'post' },
  {
    methodId: 'auth.usernameCheck',
    path: '/reg/:username/check_username',
    method: 'get'
  },
  {
    methodId: 'auth.emailCheck',
    path: '/reg/:email/check_email',
    method: 'get'
  },
  { methodId: undefined, path: '/reg/username/check', method: 'post' },
  { methodId: undefined, path: '/reg/email/check', method: 'post' },
  { methodId: undefined, path: '/system/*', method: 'all' },
  {
    methodId: 'system.createUser',
    path: '/system/create-user',
    method: 'post'
  },
  {
    methodId: 'system.createUser',
    path: '/register/create-user',
    method: 'post'
  },
  {
    methodId: 'system.createPoolUser',
    path: '/system/pool/create-user',
    method: 'post'
  },
  {
    methodId: 'system.getUsersPoolSize',
    path: '/system/pool/size',
    method: 'get'
  },
  {
    methodId: 'system.getUserInfo',
    path: '/system/user-info/:username',
    method: 'get'
  },
  {
    methodId: 'system.deactivateMfa',
    path: '/system/users/:username/mfa',
    method: 'delete'
  },
  {
    methodId: 'getAccessInfo',
    path: '/:username/access-info',
    method: 'get'
  },
  { methodId: 'callBatch', path: '/:username', method: 'post' },
  {
    methodId: 'accesses.get',
    path: '/:username/accesses',
    method: 'get'
  },
  {
    methodId: 'accesses.create',
    path: '/:username/accesses',
    method: 'post'
  },
  {
    methodId: 'accesses.update',
    path: '/:username/accesses/:id',
    method: 'put'
  },
  {
    methodId: 'accesses.delete',
    path: '/:username/accesses/:id',
    method: 'delete'
  },
  {
    methodId: 'accesses.checkApp',
    path: '/:username/accesses/check-app',
    method: 'post'
  },
  {
    methodId: 'account.get',
    path: '/:username/account',
    method: 'get'
  },
  {
    methodId: 'account.update',
    path: '/:username/account',
    method: 'put'
  },
  {
    methodId: 'account.changePassword',
    path: '/:username/account/change-password',
    method: 'post'
  },
  {
    methodId: 'account.requestPasswordReset',
    path: '/:username/account/request-password-reset',
    method: 'post'
  },
  {
    methodId: 'account.resetPassword',
    path: '/:username/account/reset-password',
    method: 'post'
  },
  { methodId: undefined, path: '/:username/auth*', method: 'all' },
  {
    methodId: undefined,
    path: '/:username/auth/who-am-i',
    method: 'get'
  },
  {
    methodId: 'auth.login',
    path: '/:username/auth/login',
    method: 'post'
  },
  {
    methodId: 'auth.logout',
    path: '/:username/auth/logout',
    method: 'post'
  },
  { methodId: 'events.get', path: '/:username/events/', method: 'get' },
  {
    methodId: 'events.getOne',
    path: '/:username/events/:id',
    method: 'get'
  },
  {
    methodId: 'events.getAttachment',
    path: '/:username/events/:id/:fileId/:fileName?',
    method: 'get'
  },
  {
    methodId: 'events.create',
    path: '/:username/events/',
    method: 'post'
  },
  {
    methodId: undefined,
    path: '/:username/events/start',
    method: 'post'
  },
  {
    methodId: 'events.update',
    path: '/:username/events/:id',
    method: 'put'
  },
  {
    methodId: undefined,
    path: '/:username/events/stop',
    method: 'post'
  },
  {
    methodId: 'events.update',
    path: '/:username/events/:id',
    method: 'post'
  },
  {
    methodId: 'events.delete',
    path: '/:username/events/:id',
    method: 'delete'
  },
  {
    methodId: 'events.deleteAttachment',
    path: '/:username/events/:id/:fileId',
    method: 'delete'
  },
  {
    methodId: 'followedSlices.get',
    path: '/:username/followed-slices',
    method: 'get'
  },
  {
    methodId: 'followedSlices.create',
    path: '/:username/followed-slices',
    method: 'post'
  },
  {
    methodId: 'followedSlices.update',
    path: '/:username/followed-slices/:id',
    method: 'put'
  },
  {
    methodId: 'followedSlices.delete',
    path: '/:username/followed-slices/:id',
    method: 'delete'
  },
  {
    methodId: 'profile.getPublic',
    path: '/:username/profile/public',
    method: 'get'
  },
  {
    methodId: 'profile.update',
    path: '/:username/profile/public',
    method: 'put'
  },
  {
    methodId: 'profile.getApp',
    path: '/:username/profile/app',
    method: 'get'
  },
  {
    methodId: 'profile.updateApp',
    path: '/:username/profile/app',
    method: 'put'
  },
  {
    methodId: 'profile.get',
    path: '/:username/profile/private',
    method: 'get'
  },
  {
    methodId: 'profile.update',
    path: '/:username/profile/private',
    method: 'put'
  },
  {
    methodId: 'service.info',
    path: '/:username/service/info',
    method: 'get'
  },
  {
    methodId: 'service.info',
    path: '/:username/service/infos',
    method: 'get'
  },
  {
    methodId: 'streams.get',
    path: '/:username/streams',
    method: 'get'
  },
  {
    methodId: 'streams.create',
    path: '/:username/streams',
    method: 'post'
  },
  {
    methodId: 'streams.update',
    path: '/:username/streams/:id',
    method: 'put'
  },
  {
    methodId: 'streams.delete',
    path: '/:username/streams/:id',
    method: 'delete'
  },
  {
    methodId: 'webhooks.get',
    path: '/:username/webhooks',
    method: 'get'
  },
  {
    methodId: 'webhooks.getOne',
    path: '/:username/webhooks/:id',
    method: 'get'
  },
  {
    methodId: 'webhooks.create',
    path: '/:username/webhooks',
    method: 'post'
  },
  {
    methodId: 'webhooks.update',
    path: '/:username/webhooks/:id',
    method: 'put'
  },
  {
    methodId: 'webhooks.delete',
    path: '/:username/webhooks/:id',
    method: 'delete'
  },
  {
    methodId: 'webhooks.test',
    path: '/:username/webhooks/:id/test',
    method: 'post'
  },
  {
    methodId: 'audit.getLogs',
    path: '/:username/audit/logs',
    method: 'get'
  }
];

module.exports = routes;
