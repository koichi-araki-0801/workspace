// QWebChannel を初期化し、window.rpc(method, args) -> Promise を公開する。
// window.__rpcReady は接続完了で解決される Promise。app.js はこれを await する。
(function () {
  var seq = 0;
  var pending = {};
  var progressHandlers = [];

  window.__rpcReady = new Promise(function (resolve) {
    window.__resolveRpcReady = resolve;
  });
  window.onProgress = function (cb) { progressHandlers.push(cb); };

  function setup(channel) {
    var backend = channel.objects.backend;
    if (!backend) {
      console.error("backend object not found over QWebChannel");
      return;
    }
    window.__backend = backend;

    backend.result.connect(function (s) {
      var r;
      try { r = JSON.parse(s); } catch (e) { return; }
      var p = pending[r.reqId];
      if (!p) return;
      delete pending[r.reqId];
      if (r.ok) p.resolve(r.data);
      else p.reject(new Error(r.error || "RPC error"));
    });

    if (backend.progress) {
      backend.progress.connect(function (msg) {
        progressHandlers.forEach(function (h) { try { h(msg); } catch (e) {} });
      });
    }

    window.rpc = function (method, args) {
      var reqId = String(++seq);
      return new Promise(function (resolve, reject) {
        pending[reqId] = { resolve: resolve, reject: reject };
        backend.call(JSON.stringify({ reqId: reqId, method: method, args: args || {} }));
      });
    };

    window.__resolveRpcReady();
  }

  function boot() {
    if (typeof QWebChannel === "undefined" || !window.qt || !qt.webChannelTransport) {
      console.error("QWebChannel transport unavailable");
      return;
    }
    new QWebChannel(qt.webChannelTransport, setup);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
