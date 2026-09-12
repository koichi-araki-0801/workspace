// =============================================================================
// e2e-rest-server.ts — e2e 専用のサーバ起動エントリ
// =============================================================================
// playwright.config.ts が webServer として起動する(chromium / docs の両 project で使う)。
// `config.ts` は import 時に `process.env` を解決するため、`PORT` 等は `serve.ts` の
// 動的 import より前に設定する(静的 import では一時 `DATA_ROOT` が効かない)。
// dataRoot はリポジトリ内の gitignore 済み固定パス(`.tmp/e2e-rest-dataroot`)を毎回
// 作り直して使う。パス定数は `e2e-rest-paths.ts`、seed 本体は `e2e-rest-seed.ts` 側に置き、
// 本ファイルは何も export しない。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_REST_DATA_ROOT, E2E_REST_PORT } from './e2e-rest-paths.js';
import { seedDataRoot } from './e2e-rest-seed.js';

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  // loopback かつ非 production なので `assertSafeExposure` は素通しし、`cookieSecure` は
  // 既定の false になる(平文 HTTP でセッション cookie が落ちない)。`AUDIT_DB=true` は
  // 監査ログの sproc 経路をフェイク越しに実際へ通すため。
  process.env.PORT = String(E2E_REST_PORT);
  process.env.HOST = '127.0.0.1';
  process.env.AUTH_REQUIRED = 'true';
  process.env.AUDIT_DB = 'true';
  process.env.DATA_ROOT = E2E_REST_DATA_ROOT;
  // 作成タブ(`POST /api/generate`)は Python 生成器を子プロセスで呼ぶ。素の `python` は
  // Windows で Store のスタブへ解決される端末があるため(exit 9009)、ランチャを既定にする。
  process.env.PYTHON_BIN ??= process.platform === 'win32' ? 'py' : 'python3';

  await seedDataRoot(repoRoot);

  // `config.ts` が import 時に上記の env を読むため、`serve.ts` は動的 import で遅らせる。
  const { createSprocClient } = await import('../src/db/sproc.js');
  const { createFakeQuery } = await import('../test/fakes/sprocFake.js');
  const { startServer } = await import('../src/serve.js');

  await startServer({ sproc: createSprocClient(await createFakeQuery()) });
  console.log(
    `[e2e-rest-server] listening on http://127.0.0.1:${E2E_REST_PORT} (dataRoot=${E2E_REST_DATA_ROOT})`,
  );
}

// 入口ガード。実行される側の副作用(env 書き換え・dataRoot の全消去・ポート占有)は
// すべて破壊的なので、誤って import されたときに走らせない。tsx は起動対象の絶対パスを
// `process.argv[1]` に置くため、自ファイルのパスと一致するときだけ本体を動かす。
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
