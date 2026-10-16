// window.YTHost for the Android app: wraps the native bridge (MainActivity.Bridge)
// into the promise-based interface static/app.js expects.
(function () {
  var N = window.YTNative;
  if (!N) return;
  var seq = 0, waiting = {};
  window.__ytNative = function (id, status, text) {
    var done = waiting[id];
    if (!done) return;
    delete waiting[id];
    var json = {};
    try { json = JSON.parse(text); } catch (e) {}
    done({ status: status, json: json });
  };
  function call(method, path, data) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      N.request(id, method, path, data == null ? '' : JSON.stringify(data));
    });
  }
  window.YTHost = {
    platform: 'android',
    os: 'android',
    revealLabel: 'Öffnen',
    api: call,
    save: function (id) {
      return call('POST', '/native/save', { id: id }).then(function (r) {
        if (r.status >= 400) throw new Error(r.json.error || 'Speichern fehlgeschlagen');
        return r.json;
      });
    },
    reveal: function (path) { N.reveal(path || ''); },
    openFolder: function () { N.openFolder(); },
    getFolder: function () { return Promise.resolve(N.folder()); },
    readClipboard: function () { return Promise.resolve(N.clipboard()); },
    theme: function (bg, fg) { N.theme(bg || '', fg || ''); },
    onOpenUrl: function (cb) {
      window.__ytOpen = cb;
      var url = N.takePendingUrl();
      if (url) setTimeout(function () { cb(url); }, 0);
    },
  };
})();
