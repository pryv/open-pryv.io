/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/* global document, window, fetch, URL */

/**
 * The built-in setup page of a core (served at /system/setup/ while setup is
 * pending): setup code, checks, sign in or register the first administrator,
 * second factor, finish. Same origin as the API it calls. Nothing is stored
 * in the browser: the setup session and the personal token live in this
 * page's memory only.
 */
(function () {
  'use strict';

  const APP_ID = 'pryv-setup-page';
  // The page is at <api root>/system/setup/: account routes are <api root>/<username>/...
  const apiRoot = new URL('../../', window.location.href);
  const state = { setupToken: null, status: null, username: null, personalToken: null, mfaToken: null };

  const $ = (id) => document.getElementById(id);

  function show (stepId) {
    for (const el of document.querySelectorAll('.step')) el.hidden = el.id !== stepId;
    clearMessage();
  }

  function message (text, kind) {
    const el = $('message');
    el.textContent = text;
    el.className = 'message' + (kind === 'info' ? ' info' : '');
    el.hidden = false;
  }

  function clearMessage () {
    $('message').hidden = true;
  }

  function url (path) {
    return new URL(path, apiRoot).toString();
  }

  function accountPath (username, rest) {
    return encodeURIComponent(username) + '/' + rest;
  }

  /** A JSON call; answers the body, throws an Error carrying the API's message and data. */
  async function call (method, path, opts) {
    const headers = { accept: 'application/json' };
    if (opts && opts.auth != null) headers.authorization = opts.auth;
    let body;
    if (opts && opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url(path), { method, headers, body, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    let json = null;
    try { json = await res.json(); } catch (_e) { json = null; }
    if (!res.ok) {
      const apiError = json && json.error ? json.error : {};
      const err = new Error(apiError.message || ('The server answered ' + res.status + '.'));
      err.status = res.status;
      err.data = apiError.data || {};
      err.id = apiError.id;
      throw err;
    }
    return json || {};
  }

  /** Runs a form's action with its button disabled; errors are shown. */
  function onSubmit (formId, action) {
    const form = $(formId);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; });
      try {
        clearMessage();
        await action();
      } catch (err) {
        message(err.message || String(err));
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
  }

  function onClick (id, action) {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try {
        clearMessage();
        await action();
      } catch (err) {
        message(err.message || String(err));
      } finally {
        $(id).disabled = false;
      }
    });
  }

  const asSetup = () => 'SetupSession ' + state.setupToken;

  // ------------------------------------------------------------ 1. code

  onSubmit('form-code', async () => {
    const code = $('code').value;
    try {
      const res = await call('POST', 'system/setup/session', { body: { code } });
      state.setupToken = res.setupSession.token;
    } catch (err) {
      if (err.status === 404) throw new Error('This code is not valid: it is wrong, expired, already used or replaced.');
      throw err;
    }
    $('code').value = '';
    await showChecks();
  });

  // ------------------------------------------------------------ 2. checks

  async function showChecks () {
    const res = await call('GET', 'system/setup/checks', { auth: asSetup() });
    const list = $('checks');
    list.textContent = '';
    for (const check of res.checks || []) {
      const li = document.createElement('li');
      const status = document.createElement('span');
      status.className = 'status ' + check.status;
      status.textContent = check.status;
      const title = document.createElement('strong');
      title.textContent = check.title;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = check.detail;
      li.append(status, title, detail);
      list.append(li);
    }
    show('step-checks');
  }

  onClick('checks-continue', async () => { show('step-account'); });

  // ------------------------------------------------------------ 3. account

  function selectTab (register) {
    $('tab-signin').classList.toggle('active', !register);
    $('tab-register').classList.toggle('active', register);
    $('form-signin').hidden = register;
    $('form-register').hidden = !register;
    $('form-mfa-code').hidden = true;
  }
  $('tab-signin').addEventListener('click', () => selectTab(false));
  $('tab-register').addEventListener('click', () => selectTab(true));

  async function signIn (username, password) {
    const res = await call('POST', accountPath(username, 'auth/login'), {
      auth: asSetup(),
      body: { username, password, appId: APP_ID }
    });
    state.username = username;
    if (res.mfaToken != null) {
      // The account has a second factor: the code releases the token.
      state.mfaToken = res.mfaToken;
      $('form-signin').hidden = true;
      $('form-register').hidden = true;
      $('form-mfa-code').hidden = false;
      $('mfa-code').focus();
      return;
    }
    state.personalToken = res.token;
    await afterSignIn();
  }

  onSubmit('form-signin', async () => {
    const password = $('signin-password').value;
    await signIn($('signin-username').value.trim().toLowerCase(), password);
    $('signin-password').value = '';
  });

  onSubmit('form-register', async () => {
    const username = $('register-username').value.trim().toLowerCase();
    const password = $('register-password').value;
    await call('POST', 'users', {
      auth: asSetup(),
      body: { appId: APP_ID, username, password, email: $('register-email').value.trim(), language: 'en' }
    });
    $('register-password').value = '';
    $('signin-username').value = username;
    await signIn(username, password);
  });

  onSubmit('form-mfa-code', async () => {
    const res = await call('POST', accountPath(state.username, 'mfa/verify'), {
      auth: state.mfaToken,
      body: { code: $('mfa-code').value.trim() }
    });
    $('mfa-code').value = '';
    state.mfaToken = null;
    state.personalToken = res.token;
    await afterSignIn();
  });

  /** Signed in: the account becomes the first administrator, or enables its second factor first. */
  async function afterSignIn () {
    try {
      await call('POST', 'system/setup/first-admin', {
        auth: asSetup(),
        body: { username: state.username, personalToken: state.personalToken }
      });
    } catch (err) {
      if (err.status === 403 && err.data && err.data.mfaRequired) return await startTotp();
      throw err;
    }
    $('finish-who').textContent = 'The account "' + state.username + '" is now the platform owner.';
    show('step-finish');
  }

  // ------------------------------------------------------------ 4. second factor

  async function startTotp () {
    const res = await call('POST', accountPath(state.username, 'mfa/activate'), {
      auth: state.personalToken,
      body: { method: 'totp' }
    });
    state.mfaToken = res.mfaToken;
    $('totp-secret').textContent = res.secret || '';
    $('totp-uri').textContent = res.otpauthUri || '';
    $('form-totp').hidden = false;
    $('recovery').hidden = true;
    show('step-totp');
  }

  onSubmit('form-totp', async () => {
    const res = await call('POST', accountPath(state.username, 'mfa/confirm'), {
      auth: state.mfaToken,
      body: { code: $('totp-code').value.trim() }
    });
    $('totp-code').value = '';
    state.mfaToken = null;
    $('recovery-codes').textContent = (res.recoveryCodes || []).join('\n');
    $('form-totp').hidden = true;
    $('recovery').hidden = false;
    // The token of this sign-in has no second factor: a new sign-in is needed.
    await logout();
  });

  onClick('totp-continue', async () => {
    $('totp-secret').textContent = '';
    $('totp-uri').textContent = '';
    $('recovery-codes').textContent = '';
    $('signin-username').value = state.username;
    selectTab(false);
    show('step-account');
    message('Sign in again: this time with the code of your authenticator app.', 'info');
  });

  async function logout () {
    if (state.personalToken == null || state.username == null) return;
    const token = state.personalToken;
    state.personalToken = null;
    try {
      await call('POST', accountPath(state.username, 'auth/logout'), { auth: token, body: {} });
    } catch (_e) { /* the session expires on its own */ }
  }

  // ------------------------------------------------------------ 5. finish

  onClick('finish', async () => {
    await call('POST', 'system/setup/finish', { auth: asSetup() });
    state.setupToken = null;
    await logout();
    const portal = state.status && state.status.portalUrl;
    $('done-portal').textContent = portal
      ? 'Administration continues in the portal: ' + portal
      : 'Administration continues with the admin API and bin/admin.js (no portal is configured).';
    show('step-done');
  });

  // ------------------------------------------------------------ start

  (async () => {
    try {
      const res = await call('GET', 'system/setup/status');
      state.status = res.setup;
      if (state.status.state !== 'pending') {
        show('step-done');
        return;
      }
      if (!state.status.codePending) {
        message('No setup code is valid at the moment: mint one with `node bin/admin.js setup-code --new` on a core, then enter it here.');
      }
      $('code').focus();
    } catch (err) {
      message('The setup status could not be read: ' + err.message);
    }
  })();
})();
