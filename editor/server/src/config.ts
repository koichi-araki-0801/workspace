// =============================================================================
// config.ts — サーバ設定の解決(default < appconfig.json < env)
// =============================================================================
// 設定値の優先順位は default < `appconfig.json` < 環境変数(env)。
// `appConfigSchema` でファイルを検証し、`config` として一元的に公開する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * オフライン PDF 生成に使えるブラウザ実行ファイルを解決する。
 * vivliostyle がインターネットから Chromium をダウンロードしないよう
 * (air-gapped 運用)、Windows に存在するシステムの Microsoft Edge を優先する。
 * 見つからない時は `undefined` を返し、オンライン開発では playwright 同梱の
 * ブラウザにフォールバックさせる。
 */
function resolveDefaultBrowser(): string | undefined {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * `appconfig.json` のスキーマ。全フィールドを optional とし、部分的なファイル
 * (やファイルが無い場合)も妥当とする。欠けたキーは組み込みの既定値に
 * フォールバックする。`.strict()` は未知キーを弾き、typo を早期に検出する。
 */
const appConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
    host: z.string().optional(),
    tls: z
      .object({
        pfx: z.string().optional(),
      })
      .strict()
      .optional(),
    paths: z
      .object({
        dataRoot: z.string().optional(),
        templatesDir: z.string().optional(),
        cssDir: z.string().optional(),
        draftsDir: z.string().optional(),
        reviewsDir: z.string().optional(),
        tmpDir: z.string().optional(),
        logDir: z.string().optional(),
        webDist: z.string().optional(),
      })
      .strict()
      .optional(),
    python: z
      .object({
        bin: z.string().optional(),
        script: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    pdf: z
      .object({
        executableBrowser: z.string().optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: z.string().optional(),
        pretty: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type AppConfigFile = z.infer<typeof appConfigSchema>;

/** `appconfig.json` を読み込み検証する。ファイルが無ければ `{}` を返す。 */
function loadFileConfig(): AppConfigFile {
  const file = process.env.APP_CONFIG ?? path.join(repoRoot, 'appconfig.json');
  if (!fs.existsSync(file)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`appconfig.json の読み込み/parse に失敗しました: ${file}: ${msg}`);
  }

  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`appconfig.json の内容が不正です: ${file}\n${issues}`);
  }
  return parsed.data;
}

const file = loadFileConfig();

// ── 1. 解決ヘルパ — 優先順位は default < appconfig.json < env ──
const toPath = (p: string) => path.resolve(repoRoot, p);

/** パス設定を解決する(env 優先、次に file、最後に default)。`repoRoot` 相対。 */
function resolvePath(envVal: string | undefined, fileVal: string | undefined, def: string): string {
  return toPath(envVal ?? fileVal ?? def);
}

/** boolean の env 変数('true'/'false')を parse する。未設定なら `undefined`。 */
function envBool(envVal: string | undefined): boolean | undefined {
  if (envVal === undefined) return undefined;
  return envVal.toLowerCase() === 'true';
}

const executableBrowser =
  process.env.VIVLIOSTYLE_EXECUTABLE_BROWSER ||
  file.pdf?.executableBrowser ||
  resolveDefaultBrowser();

export const config = {
  // 既定 24680 は他ツールと被りにくい帯を意図して選んだ固有ポート(3001 は Node 系定番で
  // 衝突しやすかった)。Vite dev(:24681)と対で予約する。
  port: Number(process.env.PORT ?? file.port ?? 24680),

  /**
   * listen ホスト。既定は loopback のみ(=同一マシン限定)で従来挙動を維持する。
   * 社内 LAN へ公開するときだけ `HOST=0.0.0.0` を明示する(`start.bat lan` が設定)。
   */
  host: process.env.HOST ?? file.host ?? '127.0.0.1',

  /**
   * HTTPS 待受用の TLS 設定(PFX 方式)。PEM 変換(openssl)を要さないよう Node が直接
   * 読める PFX を使う。生成は `scripts/setup-lan-https.ps1`。
   */
  tls: {
    /**
     * HTTPS の明示 opt-in(`HTTPS=true`。start.bat lan が pfx 存在時に設定)。pfx の存在だけで
     * 自動有効化すると、証明書生成後は dev モード(Vite proxy が http 固定)まで HTTPS 化して
     * プレビューが壊れるため、必ず明示させる。
     */
    enabled: envBool(process.env.HTTPS) ?? false,
    pfxPath: resolvePath(process.env.HTTPS_PFX, file.tls?.pfx, 'server/tls/editor.pfx'),
    /**
     * PFX のパスフレーズ。env 優先、無ければ pfx 隣の `<pfx>.pass`(setup-lan-https.ps1 が
     * 生成時に保存する)を読む。社内 LAN 前提でファイル併置を許容する割り切り。
     */
    get passphrase(): string | undefined {
      if (process.env.HTTPS_PFX_PASSPHRASE) return process.env.HTTPS_PFX_PASSPHRASE;
      const passFile = `${this.pfxPath}.pass`;
      return fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').trim() : undefined;
    },
  },

  /**
   * テンプレ実体(templates/css/drafts)を置く data ルート。git 版管理の対象でもある
   * (`gitRepoDir`)。ネスト git を避けるため既定は **ワークスペースリポジトリ外**
   * (repoRoot=editor の 2 つ上、例 `C:\Users\<user>\editor-data`)。env `DATA_ROOT`
   * または `appconfig.json` の `paths.dataRoot` で上書きする。移設は init-data-repo
   * スクリプトが行う(既存 editor/data からの移動)。
   */
  dataRoot: resolvePath(process.env.DATA_ROOT, file.paths?.dataRoot, '../../editor-data'),
  /** Jinja2 template ファイルを置くディレクトリ(ファイル名規約)。既定は dataRoot 配下。 */
  templatesDir: resolvePath(
    process.env.TEMPLATES_DIR,
    file.paths?.templatesDir,
    '../../editor-data/templates',
  ),
  /** ファンド別(per-fund)共有 CSS ファイルを置くディレクトリ。 */
  cssDir: resolvePath(process.env.CSS_DIR, file.paths?.cssDir, '../../editor-data/css'),
  /** 自動保存(autosave)ドラフトの作業コピー(template ごとに html/css。git 管理外)。 */
  draftsDir: resolvePath(process.env.DRAFTS_DIR, file.paths?.draftsDir, '../../editor-data/drafts'),
  /**
   * 確定保存の承認待ち申請(`data/reviews/<reqId>/`。git 管理外)。承認時に実ファイル
   * (templates/css)へ反映するまでの中間保管。`ensureRepo` が `/reviews/` を .gitignore する。
   */
  reviewsDir: resolvePath(
    process.env.REVIEWS_DIR,
    file.paths?.reviewsDir,
    '../../editor-data/reviews',
  ),
  /** テンプレ版管理の git リポジトリ(= dataRoot)。確定保存ごとに 1 コミット。 */
  gitRepoDir: resolvePath(process.env.GIT_REPO_DIR, file.paths?.dataRoot, '../../editor-data'),

  /** 本番で配信するビルド済み web SPA。 */
  webDist: resolvePath(process.env.WEB_DIR, file.paths?.webDist, 'web/dist'),

  /** 既存の Python template ジェネレータ。 */
  python: {
    bin: process.env.PYTHON_BIN ?? file.python?.bin ?? 'python',
    script: resolvePath(
      process.env.PY_GENERATE_SCRIPT,
      file.python?.script,
      'server/scripts/generate_template.py',
    ),
    timeoutMs: Number(process.env.PY_TIMEOUT_MS ?? file.python?.timeoutMs ?? 30000),
  },

  /** vivliostyle の PDF 生成に使う一時ディレクトリ。 */
  tmpDir: resolvePath(process.env.TMP_DIR, file.paths?.tmpDir, '.tmp'),

  /** PDF 生成(vivliostyle)の設定。 */
  pdf: {
    /**
     * vivliostyle の `build()` に渡すブラウザ実行ファイル。
     * env 優先、次に `appconfig.json`、次に自動検出したシステムの Edge、
     * いずれも無ければ `undefined`(= playwright 既定。オンライン開発で使う)。
     */
    executableBrowser: executableBrowser || undefined,
    /**
     * PDF ビルドを隔離実行する worker(plain ESM)。in-process の `build()` ハングを避けるため、
     * `build.ts` はこのスクリプトを `child_process` で spawn する(`pdf-build-worker.mjs` 参照)。
     */
    workerScript: resolvePath(
      process.env.VIVLIO_BUILD_WORKER,
      undefined,
      'server/scripts/pdf-build-worker.mjs',
    ),
    /**
     * 常駐 PDF ビルドワーカー(plain ESM)。`@vivliostyle/cli` を 1 回だけ import して常駐し、
     * IPC でビルドジョブを処理してプロセス(= module load)を使い回す(`buildWorkerPool.ts` 参照)。
     * `workerScript`(1 ジョブ毎に spawn する従来版)はフォールバックとして残す。
     */
    workerDaemonScript: resolvePath(
      process.env.VIVLIO_BUILD_WORKER_DAEMON,
      undefined,
      'server/scripts/pdf-build-worker-daemon.mjs',
    ),
  },

  /**
   * vivliostyle の build / preview API 設定。既定値は単一マシンのオフライン
   * デプロイ向けに調整済み。必要に応じて env で上書きする。
   */
  vivliostyle: {
    /** ライブプレビューサーバのライフサイクル(`previewManager.ts` 参照)。 */
    preview: {
      /** Vite preview サーバの loopback bind。Fastify がここへ proxy する。 */
      host: process.env.VIVLIO_PREVIEW_HOST ?? '127.0.0.1',
      /** proxy トラフィックがこのミリ秒数だけ無いと preview セッションを自動 close する。 */
      idleTtlMs: Number(process.env.VIVLIO_PREVIEW_IDLE_MS ?? 30 * 60_000),
      /** 同時 preview サーバ数の上限(各々が Vite サーバをメモリに保持する)。 */
      maxSessions: Number(process.env.VIVLIO_PREVIEW_MAX ?? 3),
    },
    /** project build のアップロード上限(`projectInput.ts` 参照)。 */
    build: {
      /** 受け付ける project zip の最大バイト数(超過時は 413)。 */
      maxProjectBytes: Number(process.env.VIVLIO_MAX_PROJECT_BYTES ?? 64 * 1024 * 1024),
      /**
       * PDF build worker(子プロセス)のタイムアウト(ms)。これを超えたら kill してエラーにする
       * (応答が永久に返らない無限スピナーを防ぐ)。`config.python.timeoutMs` と同型。
       */
      timeoutMs: Number(process.env.VIVLIO_BUILD_TIMEOUT_MS ?? 120_000),
      /**
       * 常駐 PDF ビルドワーカープールの最大プロセス数(`buildWorkerPool.ts`)。各ワーカーは
       * `@vivliostyle/cli` を読込済みで保持し import コスト(計測 ~11s)を 1 度きりにする。
       * `0` で従来の「ジョブ毎 spawn」へフォールバックする(安全弁)。
       */
      poolSize: Number(process.env.VIVLIO_BUILD_POOL ?? 2),
      /** ウォームワーカーをこのミリ秒数アイドルしたら停止し Chromium/メモリを解放する。 */
      idleTtlMs: Number(process.env.VIVLIO_BUILD_IDLE_MS ?? 5 * 60_000),
    },
  },

  /**
   * SQL Server 接続(phase 2 の REST モード)。Windows 統合認証(Integrated auth)で
   * 資格情報(credentials)は保存しない。ODBC Driver 17 は SQL Server 2012 を対象とする。
   * 予定しているアップグレード後は `DB_ODBC_DRIVER` / `DB_CONN_EXTRA`(例 Encrypt)で
   * 上書きする。接続文字列は `pool.ts`(msnodesqlv8)が消費する。
   */
  db: {
    server: process.env.DB_SERVER ?? 'localhost',
    name: process.env.DB_NAME ?? 'usrap',
    driver: process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 17 for SQL Server',
    poolMax: Number(process.env.DB_POOL_MAX ?? 4),
    get connectionString(): string {
      const extra = process.env.DB_CONN_EXTRA ?? '';
      return (
        `Driver={${this.driver}};Server=${this.server};Database=${this.name};` +
        `Trusted_Connection=yes;${extra}`
      );
    },
  },

  /** editor 自身の認証(phase 2)。秘密情報(secrets)は `appconfig.json` の外に置く。 */
  auth: {
    // 初期パスワードは ログインID(ユーザID) と同一(`userRepo.ts` 参照)。固定値の設定は持たない。
    sessionTtlHours: Number(process.env.AUTH_SESSION_TTL_HOURS ?? 12),
    cookieName: 'editor.sid',
    /**
     * セッション cookie の Secure 属性。本番既定 true だが、LAN 公開で証明書が無く
     * HTTP フォールバックした場合はブラウザが Secure cookie を保存せずログイン不能になる
     * ため、`COOKIE_SECURE=false`(start.bat lan が HTTP 時のみ設定)で明示的に落とせる。
     */
    cookieSecure: envBool(process.env.COOKIE_SECURE) ?? process.env.NODE_ENV === 'production',
  },

  /**
   * 監査イベント(audit events)を SQL Server の監査テーブルにもミラーする
   * (永続ファイルログに加えて)。既定 off なので `local` モードは DB に一切触れない。
   * REST バックエンドと併せて `AUDIT_DB=true` を設定する。
   */
  auditToDb: envBool(process.env.AUDIT_DB) ?? false,

  /**
   * REST データルートにセッション認証を強制する。既定 off なので `local`
   * モード(DB なし / ログインなし)では開放したまま PDF/generate が動き続ける。
   * REST バックエンドでは `AUTH_REQUIRED=true` を設定する(start.bat rest が設定する)。
   */
  requireAuth: envBool(process.env.AUTH_REQUIRED) ?? false,

  /** 構造化ロギング / 監査証跡(audit trail)。 */
  logging: {
    level: process.env.LOG_LEVEL ?? file.logging?.level ?? 'info',
    /** 永続化した監査ログ(logs/audit.log)を置くディレクトリ。 */
    dir: resolvePath(process.env.LOG_DIR, file.paths?.logDir, 'logs'),
    /** stdout を pretty 出力する。未指定時は「本番以外(outside production)」を既定とする。 */
    pretty:
      envBool(process.env.LOG_PRETTY) ??
      file.logging?.pretty ??
      process.env.NODE_ENV !== 'production',
  },
};
