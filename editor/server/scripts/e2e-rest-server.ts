// =============================================================================
// e2e-rest-server.ts — e2e 専用のサーバ起動エントリ
// =============================================================================
// playwright.config.ts が webServer として起動する(chromium / docs の両 project で使う)。
// `config.ts` は import 時に `process.env` を解決するため、`PORT` 等は `serve.ts` の
// 動的 import より前に設定する(静的 import では一時 `DATA_ROOT` が効かない)。
// dataRoot はリポジトリ内の gitignore 済み固定パス(`.tmp/e2e-rest-dataroot`)を毎回
// 作り直して使う。パス定数は `e2e-rest-paths.ts`、seed 本体は `e2e-rest-seed.ts` 側に置き、
// 本ファイルは何も export しない。

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2E_REST_CONTROL_PORT,
  E2E_REST_DATA_ROOT,
  E2E_REST_LOG_DIR,
  E2E_REST_PORT,
} from './e2e-rest-paths.js';
import { seedDataRoot } from './e2e-rest-seed.js';

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  // 端末の運用用 appconfig と生成器設定を E2E へ流入させない。
  process.env.APP_CONFIG = path.join(repoRoot, 'editor', 'appconfig.example.json');
  process.env.PY_GENERATE_SCRIPT = path.join(
    repoRoot,
    'editor',
    'server',
    'scripts',
    'fake_generate_template.py',
  );
  delete process.env.PY_GENERATE_SCRIPT_SHA256;

  // loopback かつ非 production なので `assertSafeExposure` は素通しし、`cookieSecure` は
  // 既定の false になる(平文 HTTP でセッション cookie が落ちない)。`AUDIT_DB=true` は
  // 監査ログの sproc 経路をフェイク越しに実際へ通すため。
  process.env.PORT = String(E2E_REST_PORT);
  process.env.HOST = '127.0.0.1';
  process.env.AUTH_REQUIRED = 'true';
  process.env.AUDIT_DB = 'true';
  process.env.DATA_ROOT = E2E_REST_DATA_ROOT;
  // ログ(監査ログ・修正履歴)も実行ごとの使い捨てにする(理由は `e2e-rest-paths.ts`)。
  // `logger.ts` が import 時に作り直すので、ここでは消すだけでよい。
  process.env.LOG_DIR = E2E_REST_LOG_DIR;
  await fs.rm(E2E_REST_LOG_DIR, { recursive: true, force: true });
  // 作成タブ(`POST /api/generate`)は生成器を子プロセスで呼ぶ。Windows は既定の PATH 上の
  // `python` を使う(開発機もユーザー環境変数 PATH の先頭に Python 3.13 を置く)。`python` が
  // Python 3 を指すとは限らない Linux(CI)だけ python3 を直接指す。
  if (process.platform !== 'win32') {
    process.env.PYTHON_BIN ??= 'python3';
  }

  // 帳票の組版ツール(create_report.py)は偽物に向ける。本物は遮断端末にしか無く、本物の dataRoot を
  // 書き換えうるので、e2e では本物を設定しない。シェルに本物の設定が残っていても必ず上書きし、
  // 本物の指紋も消す(偽物を本物の指紋で照合して止まらないように)。
  delete process.env.REPORT_SCRIPT_SHA256;
  process.env.REPORT_SCRIPT = path.join(
    repoRoot,
    'editor',
    'server',
    'scripts',
    'fake_create_report.py',
  );

  await seedDataRoot(repoRoot);

  // `config.ts` が import 時に上記の env を読むため、`serve.ts` は動的 import で遅らせる。
  const { createSprocClient } = await import('../src/db/sproc.js');
  const { createFakeQuery } = await import('../test/fakes/sprocFake.js');
  const { startServer } = await import('../src/serve.js');

  // テスト専用の制御ルート。`startServer` は app を返さず、本番の `buildApp` へテスト専用
  // ルートを足さない方針なので、同じプロセスに別の loopback サーバを立てる(`resetLoginRateLimit`
  // が触るのは同じモジュールインスタンスの計数)。127.0.0.1 でしか待ち受けないため認証は
  // 不要のままにする: 受けるのは計数の白紙化だけで、e2e サーバ自体が使い捨てのフェイク環境。
  const { resetLoginRateLimit } = await import('../src/auth/loginRateLimit.js');
  const control = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__e2e/reset-login-limit') {
      resetLoginRateLimit();
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(E2E_REST_CONTROL_PORT, '127.0.0.1', resolve);
  });

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
