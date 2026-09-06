// =============================================================================
// check-ports.test.mjs — ポート使用中の判定を loopback の両アドレスで固定する
// =============================================================================
// 判定を bind でなく connect で行う理由は `check-ports.mjs` 冒頭にある。ここで守るのは
// 「`127.0.0.1` だけで待つ listener」「`::1` だけで待つ listener」のどちらも使用中と判定し、
// listener を閉じたら空きに戻ること。CLI は使用中のとき exit 1 と日本語の理由を出す。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBusyPorts, isListening } from './check-ports.mjs';

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url))), 'check-ports.mjs');

// 指定 host で空きポートに listen し、`{ port, close }` を返す。host が使えない環境
// (IPv6 無効で `::1` に bind できない等)は null。
function listenOn(host) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(null));
    srv.listen({ port: 0, host }, () => {
      done({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

for (const host of ['127.0.0.1', '::1']) {
  test(`${host} だけで待つ listener を使用中と判定し、閉じたら空きに戻る`, async (t) => {
    const l = await listenOn(host);
    if (!l) return t.skip(`${host} に bind できない環境`);
    try {
      assert.deepEqual(await findBusyPorts([l.port]), [{ port: l.port, host }]);
      assert.equal(await isListening(l.port, host), true);
    } finally {
      await l.close();
    }
    assert.deepEqual(await findBusyPorts([l.port]), []);
  });
}

test('CLI は使用中のポートがあると exit 1 で理由を出す', async () => {
  const l = await listenOn('127.0.0.1');
  try {
    const res = spawnSync(process.execPath, [SCRIPT, String(l.port)], { encoding: 'utf8' });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`使用中: 127\\.0\\.0\\.1:${l.port}`));
    assert.match(res.stderr, /古いコードのサーバ/);
  } finally {
    await l.close();
  }
});

test('CLI は全部空きなら exit 0', async () => {
  const l = await listenOn('127.0.0.1');
  const port = l.port;
  await l.close(); // 直前まで使っていたポートは今は空き
  const res = spawnSync(process.execPath, [SCRIPT, String(port)], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`空き: ${port}`));
});

test('CLI は引数が無い/数値でないと exit 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'abc'], { encoding: 'utf8' }).status, 2);
});
