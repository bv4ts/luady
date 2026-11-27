// Finishes connecting Google or Wispr Flow from the website.
//
// The provider sends the browser back to the hub's callback, a cross-site request that the strict session cookie does
// not travel with. So the callback only serves connect-return.html, and this file (never inline, so the strict CSP
// holds) posts the provider's code and state to the hub as a same-origin request: with the cookie, the page key and
// the CSRF token. The hub accepts it only from the session that started the connect, once, within 10 minutes.
(function () {
  'use strict';

  var PAGE_KEY_STORAGE = 'hub.pageKey';
  var PAGE_KEY_HEADER = 'x-hub-key';
  var CSRF_HEADER = 'x-hub-csrf';
  var NAMES = { google: 'Google', wispr: 'Wispr Flow' };

  var status = document.getElementById('status');
  function say(text) {
    if (status) status.textContent = text;
  }

  var match = /^\/api\/(google|wispr)\/callback$/.exec(window.location.pathname);
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  var state = params.get('state');
  // The code is single use: keep it out of the address bar and the history.
  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch (err) {
    // Nothing to do: the address is only cosmetic here.
  }

  if (!match || !code || !state) {
    say('This page is opened by the account provider after you approve. Start again from Settings on the website.');
    return;
  }
  var service = match[1];
  var name = NAMES[service];

  var key = null;
  try {
    key = window.localStorage.getItem(PAGE_KEY_STORAGE);
  } catch (err) {
    key = null;
  }
  if (!key) {
    say('Sign in on the website in this browser, then connect ' + name + ' again from Settings.');
    return;
  }

  function readJson(response) {
    return response.json().then(
      function (body) { return { ok: response.ok, status: response.status, body: body }; },
      function () { return { ok: response.ok, status: response.status, body: null }; }
    );
  }

  function messageOf(result) {
    var error = result.body && result.body.error;
    if (error && typeof error.message === 'string') return error.message;
    return 'The hub answered ' + result.status + '.';
  }

  var keyHeader = {};
  keyHeader[PAGE_KEY_HEADER] = key;

  window.fetch('/api/me', { credentials: 'same-origin', headers: keyHeader })
    .then(readJson)
    .then(function (me) {
      if (!me.ok || !me.body || typeof me.body.csrf !== 'string') {
        throw new Error('Sign in on the website in this browser, then connect ' + name + ' again from Settings.');
      }
      var headers = { 'content-type': 'application/json' };
      headers[PAGE_KEY_HEADER] = key;
      headers[CSRF_HEADER] = me.body.csrf;
      return window.fetch('/api/connect/' + service + '/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers,
        body: JSON.stringify({ code: code, state: state }),
      });
    })
    .then(readJson)
    .then(function (result) {
      if (result.ok && result.body && typeof result.body.message === 'string') {
        say('✅ ' + result.body.message + ' You can close this tab.');
      } else {
        say('❌ ' + name + ' did not connect: ' + messageOf(result));
      }
    })
    .catch(function (err) {
      say('❌ ' + (err && err.message ? err.message : name + ' did not connect.'));
    });
})();
