// QWebChannel JS クライアント (最小実装)。
//
// Qt 同梱の qwebchannel.js が PySide6 にloose fileとして含まれないため、本アプリが
// 使う範囲 — メソッド呼び出し (invokeMethod) とシグナル購読 (connectToSignal) — に
// 絞って QWebChannel のワイヤプロトコルを実装する。プロパティ/列挙は Bridge が
// 持たないので扱わない。transport (qt.webChannelTransport) は WebEngine が自動注入。
"use strict";
(function (global) {
  var T = {
    signal: 1,
    propertyUpdate: 2,
    init: 3,
    idle: 4,
    debug: 5,
    invokeMethod: 6,
    connectToSignal: 7,
    disconnectFromSignal: 8,
    setProperty: 9,
    response: 10,
  };

  function QWebChannel(transport, initCallback) {
    if (!transport || typeof transport.send !== "function") {
      console.error("QWebChannel: invalid transport");
      return;
    }
    var self = this;
    this.transport = transport;
    this.objects = {};
    this.execId = 0;
    this.execCallbacks = {};

    this.send = function (obj) {
      transport.send(JSON.stringify(obj));
    };

    this.exec = function (obj, cb) {
      if (cb) {
        obj.id = self.execId++;
        self.execCallbacks[obj.id] = cb;
      }
      self.send(obj);
    };

    transport.onmessage = function (message) {
      var data = message.data;
      if (typeof data === "string") data = JSON.parse(data);
      switch (data.type) {
        case T.response:
          var cb = self.execCallbacks[data.id];
          if (cb) {
            delete self.execCallbacks[data.id];
            cb(data.data);
          }
          break;
        case T.signal:
          var obj = self.objects[data.object];
          if (obj) obj.__emit__(data.signal, data.args || []);
          break;
        case T.propertyUpdate:
          // プロパティ未使用。idle を返してパブリッシャを進める。
          self.send({ type: T.idle });
          break;
        default:
          break;
      }
    };

    this.exec({ type: T.init }, function (objectsMap) {
      for (var name in objectsMap) {
        new QObject(name, objectsMap[name], self);
      }
      self.send({ type: T.idle });
      if (initCallback) initCallback(self);
    });
  }

  function QObject(name, data, channel) {
    var self = this;
    this.__id__ = name;
    this.__handlers__ = {}; // signalIndex -> [cb]
    channel.objects[name] = this;

    (data.methods || []).forEach(function (m) {
      var mname = m[0],
        midx = m[1];
      if (self[mname]) return;
      self[mname] = function () {
        var args = Array.prototype.slice.call(arguments);
        // Qt のパブリッシャは id 付き (応答コールバック有り) の invokeMethod を期待する。
        channel.exec(
          { type: T.invokeMethod, object: name, method: midx, args: args },
          function () {}
        );
      };
    });

    (data.signals || []).forEach(function (sg) {
      var sname = sg[0],
        sidx = sg[1];
      self[sname] = {
        connect: function (cb) {
          if (!self.__handlers__[sidx]) {
            self.__handlers__[sidx] = [];
            channel.exec({
              type: T.connectToSignal,
              object: name,
              signal: sidx,
            });
          }
          self.__handlers__[sidx].push(cb);
        },
      };
    });

    this.__emit__ = function (sidx, args) {
      var hs = self.__handlers__[sidx];
      if (hs) hs.forEach(function (h) { h.apply(null, args); });
    };
  }

  global.QWebChannel = QWebChannel;
})(window);
