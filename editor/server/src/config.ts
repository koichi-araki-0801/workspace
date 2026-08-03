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
        draftsDir: z.string().optional(),
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

/** boolean の env 変数('true'/'false')を parse する。未設定なら `undefined`。 */
function envBool(envVal: string | undefined): boolean | undefined {
  if (envVal === undefined) return undefined;
  return envVal.toLowerCase() === 'true';
}

/**
 * 正の有限数を要求する env 変数を解決する。上限(サイズ制限)に `Number()` を直接使うと
 * `'64MB'` のような打ち間違いが `NaN` になり、`size > NaN` が常に false = 上限が黙って
 * 消える。非数値・0 以下は既定値へ倒し、上限が必ず有効であることを保証する。
 *
 * `config` の外にも上限を持つモジュール(`vivliostyle/projectInput.ts` の展開上限)が
 * あるため export する。**資源上限を env で上書きできるようにするときは必ずこれを通す**
 * — 素の `Number()` は上限を無効化できる経路になる。
 */
export function envPositiveNumber(envVal: string | undefined, def: number): number {
  const n = Number(envVal);
  return envVal !== undefined && Number.isFinite(n) && n > 0 ? n : def;
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
      maxProjectBytes: envPositiveNumber(process.env.VIVLIO_MAX_PROJECT_BYTES, 64 * 1024 * 1024),
      /**
       * 結合 build(`/build/merge`、JSON)の本文サイズ上限。複数 HTML を 1 リクエストに
       * 載せるためグローバル bodyLimit(8MB)では足りず、ルート単位で上書きする(超過時は 413)。
       */
      maxMergeBytes: envPositiveNumber(process.env.VIVLIO_MAX_MERGE_BYTES, 32 * 1024 * 1024),
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
    // 初期 / リセットのパスワードは払い出しごとの CSPRNG 一時パスワード(`userRepo.ts` 参照)。
    // 設定として固定値は持たない — 持てば全環境で同じ既定資格情報になる。
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

/**
 * 認証なしのまま外部へ待ち受ける設定を起動前に弾く(fail closed)。`requireAuth` が false だと
 * `requireAuth`/`requireAdmin`/`requireApprover` が素通りし、テンプレの読み書きも承認も
 * 無資格で通ってしまう。ホスト公開(`HOST=0.0.0.0`)と認証(`AUTH_REQUIRED`)は別々の
 * スイッチで、`start.bat` の引数の組み合わせ次第で片方だけ立つ事故が起きうるため、
 * 「公開しているのに認証オフ」の組み合わせだけは起動を拒否する。
 */
export function assertAuthRequiredWhenExposed(host: string, requireAuth: boolean): void {
  if (requireAuth || isLoopbackHost(host)) return;
  throw new Error(
    `[config] HOST=${host} は loopback ではない(=外部から到達できる)のに認証が無効です。` +
      ' LAN へ公開するなら AUTH_REQUIRED=true を指定してください' +
      '(editor\\start.bat は lan 指定時に自動で立てます)。' +
      ' 同一マシンだけで使うなら HOST を 127.0.0.1 のままにしてください。',
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
 * 認証より前に本文を積んでしまうリクエストか(`app.ts` の `onRequest` ゲートの判定)。
 *
 * Fastify のライフサイクルは onRequest → parsing → preHandler で、`requireAuth` は
 * preHandler。つまり本文の解析は常に認証より先に終わる。content-type だけを見ていた頃は
 * `application/json` へ変えるだけで `POST /api/build/merge` の 32MB を未認証で積めたため、
 * 「上限を引き上げたルート」も path で見る。
 */
export function isPreAuthBufferedRequest(
  method: string | undefined,
  url: string | undefined,
  contentType: string | undefined,
): boolean {
  if (isBufferedUploadContentType(contentType)) return true;
  // 本文を持たないメソッド(GET/HEAD/DELETE)は積みようがないので、無駄なセッション解決を避ける。
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
  const pathOnly = (url ?? '').split(/[?#]/, 1)[0];
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
    // `'unsafe-eval'`: プレビューの Jinja 描画に使う nunjucks が、テンプレートを実行時に
    // JS へコンパイルする(`new Function`)。除くとプレビュー(worker 側も含む)が全滅する。
    // inline script はハッシュ許可のみで、`'unsafe-inline'` は載せない。
    scriptSrc: ["'self'", "'unsafe-eval'", ...inlineScriptHashes],
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

// 危険な既定値(認証オフ + 外部公開)は起動前に落とす。値の解決直後に評価するので、
// `app.ts` が listen する前 — import 時点で失敗する。
assertAuthRequiredWhenExposed(config.host, config.requireAuth);
