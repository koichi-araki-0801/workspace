// ローカル HTTP サーバ (app.py / web.server) の /rpc を叩く RPC クライアント。
// QtWebChannel を廃し fetch ベースへ。window.rpc(method, args) -> Promise を公開する。
//
// 後方互換: app.js は起動時に window.__rpcReady を await し、window.onProgress(cb) で
// 進捗コールバックを登録する。HTTP 化で接続ハンドシェイクは不要になったため __rpcReady は
// 即解決済み。進捗はフロント側がループの i/N を直接 setHint するため onProgress は no-op。
(function () {
  "use strict";

  window.__rpcReady = Promise.resolve();
  window.onProgress = function () {}; // 進捗はフロントがローカル表示 (サーバ push 廃止)

  window.rpc = async function (method, args) {
    var res = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: method, args: args || {} }),
    });
    var j = await res.json();
    if (j.ok) return j.data;
    throw new Error(j.error || "RPC error");
  };
})();
