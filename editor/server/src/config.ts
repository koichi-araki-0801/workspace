// =============================================================================
// config.ts — サーバ設定の解決(default < appconfig.json < env)
// =============================================================================
// 設定値の優先順位は default < `appconfig.json` < 環境変数(env)。
// `appConfigSchema` でファイルを検証し、`config` として一元的に公開する。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiPaths } from '@editor/shared';
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
        assetsDir: z.string().optional(),
        draftsDir: z.string().optional(),
        pendingDir: z.string().optional(),
        reviewsDir: z.string().optional(),
        syncDir: z.string().optional(),
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

/** 真値として受理するトークン(trim + 小文字化して比較)。 */
const ENV_TRUE_TOKENS: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
/** 偽値として受理するトークン。 */
const ENV_FALSE_TOKENS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * boolean の env 変数を**許可トークン集合**で parse する。未設定なら `undefined`
 * (既定値へのフォールバックは呼び出し側の `??` が担う)。集合外は throw する。
 *
 * 旧実装は `=== 'true'` の 1 つだけを真とし、それ以外を**すべて false へ倒していた**ため、
 * `AUTH_REQUIRED=1` と書いた運用者は認証が無効のまま起動していた(fail-open)。未知の値を
 * 既定へ倒す案は「静かな降格」が残るので採らない — 誤記は起動中止で運用者に届ける。
 */
function envFlag(name: string, envVal: string | undefined): boolean | undefined {
  if (envVal === undefined) return undefined;
  const t = envVal.trim().toLowerCase();
  if (ENV_TRUE_TOKENS.has(t)) return true;
  if (ENV_FALSE_TOKENS.has(t)) return false;
  throw new Error(
    `[config] ${name}=${JSON.stringify(envVal)} は真偽値として解釈できません。` +
      ` 真: ${[...ENV_TRUE_TOKENS].join('/')} / 偽: ${[...ENV_FALSE_TOKENS].join('/')}` +
      ' のいずれかを指定してください(Windows の set は `set "X=true"` 形式で、' +
      '値にクォートを含めないこと)。',
  );
}

/** 10 進表記のみを受理する形(`0x10` が 16 に、`1e10` が 1e10 になる `Number` の緩さを排除)。 */
const DECIMAL_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/** 数値 env の受理条件。`min` 未満 / `max` 超過 / 形式違反はすべて throw。 */
export interface EnvNumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
  /** `min` を含めない(`envPositiveNumber` が 0 を弾くために使う)。 */
  exclusiveMin?: boolean;
}

/**
 * 数値の env 変数を**形式の許可リスト**で解決する。上限(サイズ制限)に `Number()` を
 * 直接使うと `'64MB'` のような打ち間違いが `NaN` になり、`size > NaN` が常に false =
 * 上限が黙って消える。ここでは 10 進表記に一致しない値・範囲外の値を **throw** する
 * (既定へ倒すと打ち間違いに一生気付けない = 上限を上書きしたつもりの無防備が残る)。
 *
 * `config` の外にも上限を持つモジュール(`vivliostyle/projectInput.ts` の展開上限)が
 * あるため export する。**資源上限を env で上書きできるようにするときは必ずこれを通す**
 * — 素の `Number()` は上限を無効化できる経路になる。
 */
export function envNumber(
  name: string,
  envVal: string | undefined,
  def: number,
  opts: EnvNumberOptions = {},
): number {
  if (envVal === undefined) return def;
  const raw = envVal.trim();
  const min = opts.min ?? 0;
  const range =
    `${opts.integer ? '整数' : '10 進数'}で ${min} ${opts.exclusiveMin ? 'より大きい' : '以上'}` +
    `${opts.max === undefined ? '' : ` かつ ${opts.max} 以下`}の値`;
  const fail = (why: string): never => {
    throw new Error(
      `[config] ${name}=${JSON.stringify(envVal)} は${why}。${range}を指定してください。`,
    );
  };
  if (!DECIMAL_NUMBER_RE.test(raw)) return fail('10 進の数値として解釈できません');
  const n = Number(raw);
  if (!Number.isFinite(n)) return fail('有限の数値ではありません');
  if (opts.integer && !Number.isInteger(n)) return fail('整数ではありません');
  if (n < min || (opts.exclusiveMin && n === min)) return fail(`下限 ${min} を満たしません`);
  if (opts.max !== undefined && n > opts.max) return fail(`上限 ${opts.max} を超えています`);
  return n;
}

/** 正の数(0 を含まない)を要求する env。資源上限の既定形。 */
export function envPositiveNumber(
  name: string,
  envVal: string | undefined,
  def: number,
  opts: EnvNumberOptions = {},
): number {
  return envNumber(name, envVal, def, { ...opts, min: opts.min ?? 0, exclusiveMin: true });
}

const executableBrowser =
  process.env.VIVLIOSTYLE_EXECUTABLE_BROWSER ||
  file.pdf?.executableBrowser ||
  resolveDefaultBrowser();

/**
 * HTTPS の明示 opt-in。config リテラルの内側からも参照するので先に解いておく
 * (`auth.cookieSecure` の既定値が TLS の有無に依存するため)。
 */
const tlsEnabled = envFlag('HTTPS', process.env.HTTPS) ?? false;

/**
 * `COOKIE_SECURE` の**明示指定**。`undefined` = 未指定。矛盾検査
 * (`assertSafeExposure`)は「利用者が明示的に false と書いた場合」だけを拒む —
 * NODE_ENV 由来の既定値で拒むと、`HTTPS=true` を dev で指定しただけで起動が
 * 止まりしかもメッセージが指定していない変数を名指しする。
 */
const cookieSecureExplicit = envFlag('COOKIE_SECURE', process.env.COOKIE_SECURE);

export const config = {
  // 既定 24680 は他ツールと被りにくい帯を意図して選んだ固有ポート(3001 は Node 系定番で
  // 衝突しやすかった)。Vite dev(:24681)と対で予約する。
  port: envNumber('PORT', process.env.PORT, file.port ?? 24680, {
    integer: true,
    min: 1,
    max: 65535,
  }),

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
    enabled: tlsEnabled,
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
  /**
   * **全ファンド共通**の同梱資産(`fonts/` と `js/`)を置くディレクトリ。テンプレはこれらを
   * `fonts/…` `js/…` の相対パスで参照し、PDF ビルド / プレビューの配信ルートへ
   * `vivliostyle/docAssets.ts` が写す。CSS だけ per-fund で `cssDir` に分かれているのは
   * ファンドごとに中身が違うためで、フォントと JS は共通なのでここに 1 組だけ置く。
   *
   * ⚠ この配下は **headless ブラウザが読む配信ルートへ写される**。任意のファイルを置く
   * 場所ではなく、写す対象は `docAssets.ts` の拡張子許可リストで絞る。
   */
  assetsDir: resolvePath(process.env.ASSETS_DIR, file.paths?.assetsDir, '../../editor-data/assets'),
  /** 自動保存(autosave)ドラフトの作業コピー(template ごとに html/css。git 管理外)。 */
  draftsDir: resolvePath(process.env.DRAFTS_DIR, file.paths?.draftsDir, '../../editor-data/drafts'),
  /**
   * 新規生成テンプレの未確定(pending)実体(`pending/<id>.{html,css}`)。`POST /api/generate` は
   * ここにだけ書き、確定ディレクトリ(templatesDir)へは触らない — 生成が確定ファイルを
   * 直接作れると、承認ゲートを経ない実体が本番一覧に載り、実行コード不変性の**基準そのもの**
   * を差し替えられる。git 管理**外**にするのも同じ理由で、`commitAll` の `git add -A` が
   * 未承認の内容を承認コミットへ巻き込まないため。
   */
  pendingDir: resolvePath(
    process.env.PENDING_DIR,
    file.paths?.pendingDir,
    '../../editor-data/pending',
  ),
  /**
   * 確定保存の承認待ち申請(`data/reviews/<reqId>/`。git 管理外)。承認時に実ファイル
   * (templates/css)へ反映するまでの中間保管。`ensureRepo` が `/reviews/` を .gitignore する。
   */
  reviewsDir: resolvePath(
    process.env.REVIEWS_DIR,
    file.paths?.reviewsDir,
    '../../editor-data/reviews',
  ),
  /**
   * 交付版⇄全体版 パーツ自動同期の実行状態(`sync/<pairKey>.json` = lastSynced/競合記録)。
   * テンプレ実体と同じコミットへ入れて履歴を揃えるため git 管理**内**(drafts/reviews と違い
   * .gitignore しない)。ポリシー(同期既定)は DB のパーツカタログ列で、ここには持たない。
   */
  syncDir: resolvePath(process.env.SYNC_DIR, file.paths?.syncDir, '../../editor-data/sync'),
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
    timeoutMs: envPositiveNumber(
      'PY_TIMEOUT_MS',
      process.env.PY_TIMEOUT_MS,
      file.python?.timeoutMs ?? 30000,
      { integer: true, max: 600_000 },
    ),
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
      idleTtlMs: envPositiveNumber(
        'VIVLIO_PREVIEW_IDLE_MS',
        process.env.VIVLIO_PREVIEW_IDLE_MS,
        30 * 60_000,
        { integer: true },
      ),
      /** 同時 preview サーバ数の上限(各々が Vite サーバをメモリに保持する)。 */
      maxSessions: envPositiveNumber('VIVLIO_PREVIEW_MAX', process.env.VIVLIO_PREVIEW_MAX, 3, {
        integer: true,
        max: 32,
      }),
    },
    /** project build のアップロード上限(`projectInput.ts` 参照)。 */
    build: {
      /** 受け付ける project zip の最大バイト数(超過時は 413)。 */
      maxProjectBytes: envPositiveNumber(
        'VIVLIO_MAX_PROJECT_BYTES',
        process.env.VIVLIO_MAX_PROJECT_BYTES,
        64 * 1024 * 1024,
        { integer: true },
      ),
      /**
       * 結合 build(`/build/merge`、JSON)の本文サイズ上限。複数 HTML を 1 リクエストに
       * 載せるためグローバル bodyLimit(8MB)では足りず、ルート単位で上書きする(超過時は 413)。
       */
      maxMergeBytes: envPositiveNumber(
        'VIVLIO_MAX_MERGE_BYTES',
        process.env.VIVLIO_MAX_MERGE_BYTES,
        32 * 1024 * 1024,
        { integer: true },
      ),
      /**
       * PDF build worker(子プロセス)のタイムアウト(ms)。これを超えたら kill してエラーにする
       * (応答が永久に返らない無限スピナーを防ぐ)。`config.python.timeoutMs` と同型。
       */
      timeoutMs: envPositiveNumber(
        'VIVLIO_BUILD_TIMEOUT_MS',
        process.env.VIVLIO_BUILD_TIMEOUT_MS,
        120_000,
        { integer: true, max: 600_000 },
      ),
      /**
       * 常駐 PDF ビルドワーカープールの最大プロセス数(`buildWorkerPool.ts`)。各ワーカーは
       * `@vivliostyle/cli` を読込済みで保持し import コスト(計測 ~11s)を 1 度きりにする。
       * `0` で従来の「ジョブ毎 spawn」へフォールバックする(安全弁)。
       */
      poolSize: envNumber('VIVLIO_BUILD_POOL', process.env.VIVLIO_BUILD_POOL, 2, {
        integer: true,
        min: 0,
        max: 16,
      }),
      /** ウォームワーカーをこのミリ秒数アイドルしたら停止し Chromium/メモリを解放する。 */
      idleTtlMs: envPositiveNumber(
        'VIVLIO_BUILD_IDLE_MS',
        process.env.VIVLIO_BUILD_IDLE_MS,
        5 * 60_000,
        { integer: true },
      ),
      /**
       * ワーカー待ちの行列に並べる最大件数。超過は待たせずに即エラーで返す。
       *
       * 上限が無い版では、1 ビルドが最大 `timeoutMs`(既定 120s)掛かるあいだ、到着した
       * リクエストが全部キューへ積まれた。しかも待っている間ずっと temp ディレクトリ・
       * 配信ルートへ写した資産・egress の許可ポート(1 ビルド 4 個)を握るので、
       * 「並んでいるだけ」で資源が枯れる。行列の長さは**待ち時間の上限**でもある
       * (poolSize=2・timeout=120s・queue=8 なら最悪待ち ~8 分)。
       */
      maxQueue: envPositiveNumber('VIVLIO_BUILD_MAX_QUEUE', process.env.VIVLIO_BUILD_MAX_QUEUE, 8, {
        integer: true,
        max: 256,
      }),
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
    poolMax: envPositiveNumber('DB_POOL_MAX', process.env.DB_POOL_MAX, 4, {
      integer: true,
      max: 64,
    }),
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
    // 初期 / リセットのパスワードは払い出しごとの CSPRNG 一時パスワード(`userRepo.ts` 参照)。
    // 設定として固定値は持たない — 持てば全環境で同じ既定資格情報になる。
    sessionTtlHours: envPositiveNumber(
      'AUTH_SESSION_TTL_HOURS',
      process.env.AUTH_SESSION_TTL_HOURS,
      12,
      { max: 720 },
    ),
    cookieName: 'editor.sid',
    /**
     * セッション cookie の Secure 属性。本番既定 true だが、LAN 公開で証明書が無く
     * HTTP フォールバックした場合はブラウザが Secure cookie を保存せずログイン不能になる
     * ため、`COOKIE_SECURE=false`(start.bat lan が HTTP 時のみ設定)で明示的に落とせる。
     */
    cookieSecure: cookieSecureExplicit ?? (tlsEnabled || process.env.NODE_ENV === 'production'),
    /**
     * 認証**失敗**応答に課す下限時間(ms)。存在オラクルの second channel(応答時間差)を
     * 塞ぐ防御そのものなので、解決は必ず `envNumber` を通す。素の `Number()` だと
     * `AUTH_FAILURE_FLOOR_MS=`(空)が `0` になって**無言で無効化**され、`1e9` が
     * 受理されて全失敗応答が 11 日待ちになる。KDF 60〜65ms + DB 往復の p99 を上回る
     * 300ms を既定とし、上限は 10 秒(それ以上はソケット占有で自傷になる)。
     */
    failedAuthFloorMs: envNumber('AUTH_FAILURE_FLOOR_MS', process.env.AUTH_FAILURE_FLOOR_MS, 300, {
      integer: true,
      min: 0,
      max: 10_000,
    }),
  },

  /**
   * 監査イベント(audit events)を SQL Server の監査テーブルにもミラーする
   * (永続ファイルログに加えて)。既定 off なので `local` モードは DB に一切触れない。
   * REST バックエンドと併せて `AUDIT_DB=true` を設定する。
   */
  auditToDb: envFlag('AUDIT_DB', process.env.AUDIT_DB) ?? false,

  /**
   * REST データルートにセッション認証を強制する。既定 off なので `local`
   * モード(DB なし / ログインなし)では開放したまま PDF/generate が動き続ける。
   * REST バックエンドでは `AUTH_REQUIRED=true` を設定する(start.bat rest が設定する)。
   */
  requireAuth: envFlag('AUTH_REQUIRED', process.env.AUTH_REQUIRED) ?? false,

  /** 構造化ロギング / 監査証跡(audit trail)。 */
  logging: {
    level: process.env.LOG_LEVEL ?? file.logging?.level ?? 'info',
    /** 永続化した監査ログ(logs/audit.log)を置くディレクトリ。 */
    dir: resolvePath(process.env.LOG_DIR, file.paths?.logDir, 'logs'),
    /** stdout を pretty 出力する。未指定時は「本番以外(outside production)」を既定とする。 */
    pretty:
      envFlag('LOG_PRETTY', process.env.LOG_PRETTY) ??
      file.logging?.pretty ??
      process.env.NODE_ENV !== 'production',
  },
};

// ── 2. セキュリティ方針 ──
// 判定ロジックを設定側に置くのは、消費側の `app.ts` が「import した瞬間に listen する起動
// スクリプト」でテストから読み込めないため。方針の値(上限・host・requireAuth)もここが持つ。

/**
 * ループバック(同一マシン限定)への bind か。`127.0.0.0/8`・`::1`・`localhost` のみを
 * loopback とみなし、`0.0.0.0` / `::`(全 IF)や LAN IP 直指定・空文字は外部公開扱いにする。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `assertSafeExposure` の入力。判定に要る設定値をすべて明示的に受け取る。 */
export interface ExposureOptions {
  host: string;
  /** vivliostyle preview の実 listen アドレス(`VIVLIO_PREVIEW_HOST`)。 */
  previewHost: string;
  requireAuth: boolean;
  tlsEnabled: boolean;
  cookieSecure: boolean;
  /**
   * `COOKIE_SECURE` を利用者が**明示指定**した値(未指定は `undefined`)。
   * 矛盾検査を明示指定に限るために `cookieSecure` と別に受け取る。
   */
  cookieSecureExplicit?: boolean | undefined;
  /** `ALLOW_PLAINTEXT_LAN`。平文 LAN 公開の明示 opt-in(恒久設定にしないこと)。 */
  allowPlaintext: boolean;
}

/**
 * 外部から到達できる待受構成のうち、安全でない組み合わせを起動前に落とす(fail closed)。
 * 旧 `assertAuthRequiredWhenExposed` は「公開 × 認証オフ」という**組を 1 つ列挙して拒む**
 * 形で、列挙の外(TLS 無し・preview listener の公開・Secure 属性の矛盾)が素通りしていた。
 *
 * 判定は 4 つ:
 * 1. 公開 かつ 認証オフ → 拒否。無資格でテンプレの読み書きも承認も通る。
 * 2. 公開 かつ TLS 無し → 拒否。同一 LAN からログイン資格情報が平文で読める。
 *    `allowPlaintext` のときだけ免除する(呼び出し側が WARN を出す責任を持つ)。
 * 3. preview listener が非 loopback → **免除なしで拒否**。この listener は Fastify の
 *    preHandler の外側にあり認証を掛ける手段が無い = 「認証付きで公開」という安全な状態が
 *    構成上作れないため、opt-in を用意すると必ず誤用される。
 * 4. TLS 有効なのに Secure cookie を落としている → 拒否(矛盾した指定)。逆向き
 *    (TLS 無し + Secure 有効)は前段リバースプロキシで終端する正当な構成なので見ない。
 */
export function assertSafeExposure(opts: ExposureOptions): void {
  if (!isLoopbackHost(opts.previewHost))
    throw new Error(
      `[config] VIVLIO_PREVIEW_HOST=${opts.previewHost} は loopback ではありません。` +
        ' preview サーバは Fastify の認証(preHandler)の外側で待ち受けるため、公開すると' +
        ' 展開済み zip の中身を無認証で配ることになります。127.0.0.1 のままにしてください。',
    );
  // 拒むのは「利用者が COOKIE_SECURE=false と**明示した**」場合だけ。未指定時の
  // 既定値で拒むと、`HTTPS=true` を dev で指定しただけで起動が止まり、しかも
  // 利用者が一度も書いていない変数を原因として名指すことになる。
  if (opts.tlsEnabled && !opts.cookieSecure && opts.cookieSecureExplicit === false)
    throw new Error(
      '[config] HTTPS=true と COOKIE_SECURE=false は同時に指定できません。' +
        ' TLS で待ち受けるなら セッション cookie の Secure 属性を落とす理由がありません。',
    );
  if (isLoopbackHost(opts.host)) return;
  if (!opts.requireAuth)
    throw new Error(
      `[config] HOST=${opts.host} は loopback ではない(=外部から到達できる)のに認証が無効です。` +
        ' LAN へ公開するなら AUTH_REQUIRED=true を指定してください' +
        '(editor\\start.bat は lan 指定時に自動で立てます)。' +
        ' 同一マシンだけで使うなら HOST を 127.0.0.1 のままにしてください。',
    );
  if (!opts.tlsEnabled && !opts.allowPlaintext)
    throw new Error(
      `[config] HOST=${opts.host} で外部公開するのに TLS が無効です。ログイン ID と` +
        ' パスワードが同一 LAN から平文で読めます。`editor\\scripts\\setup-lan-https.bat` で' +
        ' 証明書を作って HTTPS=true で起動してください。どうしても平文で運用する場合のみ' +
        ' `start.bat rest lan-plain`(= ALLOW_PLAINTEXT_LAN=1)を使ってください。',
    );
}

/**
 * 認証前にメモリへ全量を積むボディ(project zip)の content-type か。Fastify は
 * content-type parser を preHandler(`requireAuth`)より前に走らせるため、この判定で
 * `onRequest` 段の認証ゲートを掛ける(`app.ts`)。`; charset=` 等のパラメータは無視する。
 */
export function isBufferedUploadContentType(contentType: string | undefined): boolean {
  const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'application/zip' || mime === 'application/octet-stream';
}

/**
 * 大きな本文を受ける前提のアップロード経路(`/api` prefix 込み)。現に上限を上げているのは
 * `/build/merge`(`maxMergeBytes`)だけで、残り 2 本は zip の受け口。content-type を伏せて
 * 送られても同じ扱いにするため path でも並べる。ルート側で `bodyLimit` を引き上げたときは
 * ここへ足すこと — 足し忘れると、そのルートだけ「未認証で上限いっぱいを積める」経路に戻る。
 */
const RAISED_BODY_LIMIT_PATHS: readonly string[] = [
  `/api${apiPaths.buildMerge}`,
  `/api${apiPaths.buildProject}`,
  `/api${apiPaths.preview}`,
];

/**
 * `onRequest` ゲートが照合に使う URL を選ぶ。`request.routeOptions.url` は Fastify が
 * 実際にルーティングした**登録パターン**で、生の request target(`request.url`)と違って
 * percent-encoding・dot セグメント・absolute-form の綴り差を持たない。ルートに当たらない
 * リクエスト(404)は上限を上げたハンドラへ届かないので、生 URL への退避で足りる。
 *
 * `app.ts` から式を直接書かずここへ切り出しているのは、テストが**本番と同じ選択**を
 * 検証できるようにするため(式を写したテストは、呼び出し側だけの退行を検出できない)。
 */
export function preAuthGateUrl(request: {
  url?: string;
  routeOptions?: { url?: string };
}): string | undefined {
  return request.routeOptions?.url ?? request.url;
}

/**
 * 認証より前に本文を積んでしまうリクエストか(`app.ts` の `onRequest` ゲートの判定)。
 *
 * Fastify のライフサイクルは onRequest → parsing → preHandler で、`requireAuth` は
 * preHandler。つまり本文の解析は常に認証より先に終わる。content-type だけを見ていた頃は
 * `application/json` へ変えるだけで `POST /api/build/merge` の 32MB を未認証で積めたため、
 * 「上限を引き上げたルート」も path で見る。
 *
 * ⚠ `routedUrl` に渡すのは**生の request target ではなく `request.routeOptions.url`**
 * (Fastify が実際にルーティングした登録パターン)である。生の target で照合していた版は、
 * find-my-way が percent-encoding を解いてから照合する一方こちらは解かないため、
 * `POST /api/build/%6Derge` がゲートを外して未認証のまま 32MB を積めた(absolute-form・
 * dot セグメントも同じ)。登録パターンで照合すればその差が**構造的に**消える。
 * 選び方は `preAuthGateUrl` に閉じてあるので、呼び出し側は必ずそれを通すこと。
 */
export function isPreAuthBufferedRequest(
  method: string | undefined,
  routedUrl: string | undefined,
  contentType: string | undefined,
): boolean {
  if (isBufferedUploadContentType(contentType)) return true;
  // 本文を持たないメソッド(GET/HEAD/DELETE)は積みようがないので、無駄なセッション解決を避ける。
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
  const pathOnly = (routedUrl ?? '').split(/[?#]/, 1)[0];
  return RAISED_BODY_LIMIT_PATHS.includes(pathOnly);
}

/**
 * インライン `<script>` の CSP ハッシュ(`'sha256-...'`)を、配信する index.html そのものから
 * 算出する。SPA シェルはテーマ適用の inline script を持つため、`'unsafe-inline'` を許すか
 * ハッシュを載せるかの二択で、後者を採る(注入された script タグは弾かれたままになる)。
 * ハッシュ対象は改変後(epoch 置換後)の文字列でなければならない — 実際に配信する
 * バイト列とハッシュが一致しないとブラウザが script を落とす。
 */
export function inlineScriptCspHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    // ブラウザは HTML パーサが改行を LF へ正規化した後の本文をハッシュする。ビルド成果物の
    // index.html は CRLF になりうるため、生バイト列のまま計算すると必ず不一致になり、
    // inline script が落とされる(実測で判明)。
    const body = m[1].replace(/\r\n?/g, '\n');
    if (body.length === 0) continue;
    hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * helmet に渡す CSP ディレクティブ。SPA(Vite ビルド成果物)と blob プレビューが動く最小限に
 * 絞る。`null` は helmet の既定ディレクティブを消す指定(`useDefaults: true` 前提)。
 */
export function buildCspDirectives(
  inlineScriptHashes: readonly string[],
): Record<string, string[] | null> {
  return {
    defaultSrc: ["'self'"],
    // **アプリオリジンに eval 系の実行手段を残さない**(`'unsafe-eval'` を載せない)。
    // Jinja のコンパイルは opaque オリジンのレンダーホスト(`render/renderHost.ts`)の中
    // だけで行い、そこは別 CSP を持つ(所見 F1)。最後まで残っていた `'unsafe-eval'` の
    // 利用者は `lib/fillJinja.ts` の `toFilled`(= `nunjucks.compile` = `new Function`。
    // Worker も同一オリジンでこの CSP を継承する)だったが、`lib/jinjaExpr.ts` の
    // 許可リスト評価器へ置き換えて依存を断った。
    //
    // ⚠ 戻さないこと。`fillJinja` へフィルタ等を足したくなっても `new Function` を呼ぶ
    // 実装で解決しない — 解釈できない式は `toFilledWithDiagnostics` が件数で返し、実
    // テンプレが 1 件も許可リストの外に出ていないことを `web/test/fillJinja.test.ts` が
    // 固定する。inline script はハッシュ許可のみで、`'unsafe-inline'` は載せない。
    scriptSrc: ["'self'", ...inlineScriptHashes],
    // GrapesJS と Vue が要素の style 属性 / 動的 `<style>` を直接書くため inline を許す。
    styleSrc: ["'self'", "'unsafe-inline'"],
    // `blob:` = プレビュー・PDF の Blob URL(`URL.createObjectURL`)、`data:` = 埋め込み画像と
    // @fontsource の同梱フォント。外部ホストは許可しない(オフライン運用のため不要)。
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    // 外部ホストは許可しない。GrapesJS が `app.grapesjs.com` へ送るテレメトリはここで落ちて
    // コンソールに CSP 違反が出るが、閉域運用ではむしろ望ましい挙動で機能に影響はない。
    connectSrc: ["'self'", 'blob:', 'data:'],
    // Vite の module worker(本番は同一オリジンのチャンク)と Blob フォールバック。
    workerSrc: ["'self'", 'blob:'],
    // プレビュー iframe は Blob URL と同一オリジンの `/api/preview/...` を読み込む。
    frameSrc: ["'self'", 'blob:', 'data:'],
    // LAN 公開は証明書が無ければ平文 HTTP へ落とす運用なので、既定の
    // `upgrade-insecure-requests`(全リクエストを https へ強制)を外す。付けたままだと
    // HTTP 運用時にアセットが読めずアプリが起動しない。
    upgradeInsecureRequests: null,
  };
}

/**
 * 平文での LAN 公開を明示的に許した状態か(`ALLOW_PLAINTEXT_LAN`)。起動バナーへ
 * 警告を出すため export する。恒久設定にすると本修正の意味が消えるので、
 * `start.bat rest lan-plain` から一時的に立てる想定。
 */
export const allowPlaintextLan =
  envFlag('ALLOW_PLAINTEXT_LAN', process.env.ALLOW_PLAINTEXT_LAN) ?? false;

// 危険な待受構成(認証オフ / TLS 無し / preview の公開 / Secure の矛盾)は起動前に落とす。
// 値の解決直後に評価するので、`app.ts` が listen する前 — import 時点で失敗する。
assertSafeExposure({
  host: config.host,
  previewHost: config.vivliostyle.preview.host,
  requireAuth: config.requireAuth,
  tlsEnabled: config.tls.enabled,
  cookieSecure: config.auth.cookieSecure,
  cookieSecureExplicit,
  allowPlaintext: allowPlaintextLan,
});
