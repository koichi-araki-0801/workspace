// =============================================================================
// projectInput.ts — アップロード zip から vivliostyle プロジェクトを安全に展開する
// =============================================================================
import crypto from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isAppError, validation } from '@editor/shared';
import StreamZip from 'node-stream-zip';
import { config, envPositiveNumber } from '../config.js';
import { assertProjectDirHasNoExternalRefs } from '../security/externalRefs.js';
import { DEFAULT_DOC_BASE } from './previewProxy.js';
import { isConfigFileName, parseProjectConfig, type SafeProjectConfig } from './projectConfig.js';

/** アップロード zip から展開した vivliostyle プロジェクト。 */
interface ExtractedProject {
  /** 展開ファイルを格納するルートディレクトリ。`cleanupProject` で削除する。 */
  dir: string;
  /**
   * 許可リストで組み直した config。**CLI へはこのオブジェクトを `configData` で渡す**
   * (ファイルパスは渡さない)。config 同梱が無ければ undefined でクエリ `?entry=` 経路。
   */
  config?: SafeProjectConfig;
  /** 書き出したファイル数。 */
  fileCount: number;
  /**
   * 文書と資産が配信される path 接頭辞(config の `base`)。プレビュープロキシの許可リスト
   * (`previewProxy.allowForwardPath`)がこの値を使うので、展開時に確定させてセッションへ運ぶ。
   * `base` は利用者に指定させず我々が固定するため、実際には常に既定値である。
   */
  docBase: string;
}

// ── 展開して残すファイルの許可リスト ──
// 以前は「実行可能な config のファイル名」を数え上げて拒否していた。数え上げは漏れる:
// 別ツールの config(`vite.config.js`)、同じ名前の別綴り(`vivliostyle.config.JS`)、
// 名前では判別できない中身(theme 指定子)で 3 通りに破られた。**数え上げが漏れるのではなく、
// 数え上げるという設計が漏れる。** よって「書き出す拡張子を数える」方式へ反転する。
//
// 判定は 3 分類で、既定は reject:
//   write  — `ALLOWED_EXTENSIONS` に載る(小文字化した basename の末尾一致)
//   ignore — OS が勝手に入れるノイズ。**捨てるだけ**でセキュリティ判断には関与しない
//   reject — それ以外すべて → 展開ごと 400
// ignore を分けるのは、macOS/Windows 製の zip が常に `__MACOSX/` や `.DS_Store` を含み、
// 純粋 400 だと正常業務が回らないため。逆に非許可を黙って捨てるだけにしないのは、`.js` が
// 無言で消えると「サーバのバグでアセットが落ちた」ように見えて原因究明に時間が溶けるため。

/**
 * 展開して残す拡張子。すべて CLI 実装から決めた値で、憶測で足さないこと。
 * 原稿 = `htmlExtensions` と input format 判定、アセット = `DEFAULT_ASSET_EXTENSIONS` 逐語、
 * 宣言 = `vivliostyle.config.json` と publication manifest。
 *
 * **意図的に入れない**: `.js` `.mjs` `.cjs` `.ts`(実行面)、`.epub` `.opf`(zip-in-zip の
 * 別攻撃面)。プレビュー経路では `previewProxy` の `CONTENT_CSP` が `script-src 'none'` を
 * 当てるので、外部 `.js` を展開段でも落とすのは配信段の決定を前倒しにするだけである。
 * ⚠ **build 経路には CSP が無い**ので、ここで落ちるのは外部ファイルとしての `.js` だけで、
 * `.html` 内のインライン script は組版時に実行される(下の展開処理の注記を見よ)。
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.xht',
  '.md',
  '.markdown',
  '.css',
  '.css.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.webp',
  '.apng',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.json',
]);

/** 黙って捨てる OS ノイズ。`write` させない点は reject と同じで、400 にするかだけが違う。 */
function isIgnorableEntry(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  return (
    lower.startsWith('__macosx/') ||
    lower.includes('/__macosx/') ||
    base === '.ds_store' ||
    base === 'thumbs.db' ||
    base === 'desktop.ini' ||
    base.startsWith('._')
  );
}

/**
 * `.json` を許すと `package.json` も通る。`theme` が `.css` 実ファイルへ固定される以上
 * arborist は起動しないが、二次防御として npm の足場になる名前は落とす。
 * **これは theme 検証の代替ではない。**
 */
function isNpmArtifact(rel: string): boolean {
  const lower = rel.toLowerCase();
  const segments = lower.split('/');
  return (
    segments.includes('node_modules') ||
    segments.some((s) => s === '.npmrc' || s === 'package.json' || s === 'package-lock.json')
  );
}

/**
 * 展開して書き出してよい名前か。判定は**正規化後の相対パス**に対して行う
 * (生の `entry.name` で判定すると `x.png/../y.js` が抜ける)。小文字化するのは
 * **拒否を広げる方向の case-fold なので安全**である(受理を広げる方向では畳まない)。
 */
function isAllowedEntryName(rel: string): boolean {
  const base = rel.toLowerCase().split('/').pop() ?? '';
  // Windows は末尾の `.` / 空白 / ADS を落として別名で作成する。分類の前に落とす。
  if (base !== base.trim() || base.endsWith('.') || base.includes(':')) return false;
  if (isNpmArtifact(rel)) return false;
  return [...ALLOWED_EXTENSIONS].some((ext) => base.endsWith(ext));
}

// zip 展開の同時実行上限。多ファイルのプロジェクトで逐次 await の累積待ちを抑えつつ、
// fd/メモリの過負荷を避けるための上限。
const EXTRACT_CONCURRENCY = 8;

// ── 展開の資源上限 ──
// 圧縮後サイズの上限(`config.vivliostyle.build.maxProjectBytes`)だけでは守れない。deflate は
// ~1000:1 まで縮むため、64MB のアップロードが数十 GB の書き込みになりうる(zip bomb)。
// 検査は 2 段構えで、実効的な関所は後段:
//   前段 `assertWithinExtractLimits` — central directory の申告値による展開前の足切り。
//     正直な zip を 1 バイトも書かずに弾けるので、まともなクライアントには早く 400 を返す。
//   後段 `ExtractBudget` — 実際に書いたバイト数を数えて超えたら止める。
// 後段が必須なのは、申告値が攻撃者の自由記述だから。汎用フラグ bit3(データ記述子)を
// 立てたエントリでは node-stream-zip が CRC/サイズ検証ストリームを繋がない
// (`canVerifyCrc`: `(flags & 0x8) !== 0x8`)ため、「申告 100 バイト・実体 40MB」の zip が
// 検証なしで全量展開される。つまり申告値だけを見る検査はフラグ 1 ビットで無効化できる。
// 既定値は env で上書きできる。解決は `config.ts` と共通の `envPositiveNumber` を使う —
// 素の `Number()` だと `'256MB'` のような打ち間違いが `NaN` になり、`total > NaN` が常に
// false = 上限が黙って消える(上書きしたつもりで無防備になるのが最悪の壊れ方)。

/** 展開後の合計バイト数の上限。 */
const MAX_UNCOMPRESSED_BYTES = envPositiveNumber(
  'VIVLIO_MAX_UNZIP_BYTES',
  process.env.VIVLIO_MAX_UNZIP_BYTES,
  256 * 1024 * 1024,
  { integer: true },
);
/** 展開するファイル数の上限(inode / ディレクトリエントリの枯渇を防ぐ)。 */
const MAX_ENTRY_COUNT = envPositiveNumber(
  'VIVLIO_MAX_UNZIP_ENTRIES',
  process.env.VIVLIO_MAX_UNZIP_ENTRIES,
  5000,
  { integer: true },
);
/** 圧縮比(展開後合計 ÷ zip バイト数)の上限。 */
const MAX_COMPRESSION_RATIO = envPositiveNumber(
  'VIVLIO_MAX_UNZIP_RATIO',
  process.env.VIVLIO_MAX_UNZIP_RATIO,
  100,
);
/**
 * 圧縮比を見始める展開後サイズ。小さなプロジェクト(繰り返しの多い HTML は正当でも
 * 容易に 100 倍を超える)を誤検知で弾かないための下駄。
 */
const COMPRESSION_RATIO_FLOOR_BYTES = 8 * 1024 * 1024;

/**
 * URI スキーム(`http:` `https:` `file:` `data:` 等)の検出。Windows のドライブレター
 * (`C:`)を巻き込まないようスキーム名は 2 文字以上を要求する。ドライブレターは
 * `safeEntryPath` 側が別途弾くため、ここを通り抜けても封じ込めは崩れない。
 */
export const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

/**
 * `items` を最大 `limit` 並列で `task` に通す(順序不問)。最初の失敗で reject し、以降の
 * 未着手分は走らせない(走行中タスクは完了を待つ)。外部依存(p-limit 等)を増やさないための
 * 最小実装。
 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const run = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next;
      next += 1;
      try {
        await task(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * zip エントリ名を `root` 配下の安全な絶対パスへ解決する。
 * 絶対パス・Windows ドライブレター・`..` トラバーサルを拒否し、悪意あるアーカイブが
 * 展開ディレクトリの外へ書き込めないようにする(zip-slip)。
 */
export function safeEntryPath(root: string, name: string): string {
  const normalized = name.replace(/\\/g, '/');
  // `path.resolve` は NUL を含むパスで TypeError を投げる(= 500)。ここで 400 に落とす。
  // zip エントリ名にも NUL は入りうるので、`safeProjectEntry` 側だけでなくここでも見る。
  if (name.includes('\0')) throw validation(`不正なエントリパスです: ${name}`);
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw validation(`不正なエントリパスです: ${name}`);
  }
  const dest = path.resolve(root, normalized);
  const rel = path.relative(root, dest);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw validation(`不正なエントリパスです: ${name}`);
  }
  return dest;
}

/**
 * クエリ `entry` を展開ディレクトリ配下の絶対パスへ解決する(`buildProjectPdf` /
 * `previewManager.start` へ渡す前の唯一の関所)。
 *
 * vivliostyle CLI は `input` を `upath.resolve(cwd, input)` で解くだけで封じ込めを見ず、
 * `http(s):` / `file:` / `data:` も入力形式として受け付ける。素通しすると返る PDF の中身が
 * 「サーバ上の任意ファイル」や「サーバから到達できる任意 URL の応答」になる(任意ファイル
 * 読み出し / SSRF)。URI をここで拒否し、残りは zip エントリと同じ封じ込め
 * (`safeEntryPath`)へ通す。
 */
export function safeProjectEntry(root: string, entry: string): string {
  // `path.resolve` は NUL を含むパスで TypeError を投げる(= 500)。不正入力として 400 に落とす。
  if (URI_SCHEME_RE.test(entry) || entry.includes('\0')) {
    throw validation(`不正な entry です: ${entry}`);
  }
  return safeEntryPath(root, entry);
}

/**
 * 展開前に zip の申告値で資源上限を検査する。超過は不正入力なので `validation`(400)。
 * `zipBytes` はアップロードされた zip 自体のバイト数(圧縮比の分母)。
 */
function assertWithinExtractLimits(zipBytes: number, sizes: number[]): void {
  if (sizes.length > MAX_ENTRY_COUNT) {
    throw validation(`プロジェクト zip のファイル数が多すぎます(上限 ${MAX_ENTRY_COUNT} 件)`);
  }
  const total = sizes.reduce((n, s) => n + s, 0);
  if (total > MAX_UNCOMPRESSED_BYTES) {
    const limitMb = Math.floor(MAX_UNCOMPRESSED_BYTES / (1024 * 1024));
    throw validation(`プロジェクト zip の展開後サイズが大きすぎます(上限 ${limitMb} MB)`);
  }
  if (total > COMPRESSION_RATIO_FLOOR_BYTES && total > zipBytes * MAX_COMPRESSION_RATIO) {
    throw validation('プロジェクト zip の圧縮比が高すぎます');
  }
}

/**
 * 中央ディレクトリ(central directory)のバイト長の上限。最小 46B/件なので既定 4MB は
 * おおよそ 9 万件相当。
 */
const MAX_CENTRAL_DIRECTORY_BYTES = envPositiveNumber(
  'VIVLIO_MAX_ZIP_CD_BYTES',
  process.env.VIVLIO_MAX_ZIP_CD_BYTES,
  4 * 1024 * 1024,
  { integer: true },
);

/**
 * zip の EOCD(End Of Central Directory)から**申告**エントリ数と中央ディレクトリ長を読み、
 * 上限超過を展開前に切る。
 *
 * node-stream-zip の `entriesCount` では代用できない — あれは `'ready'` イベント待ちで、
 * `'ready'` は全エントリを読み終えた後に発火する。つまり await した時点で materialize は
 * 済んでいる。事前検査は node-stream-zip の外でやるしかない。
 *
 * **申告値なので偽れる。** ここは「materialize のコストを事前に切る」ための前段であって、
 * 真の関所は実測バイト予算(`ExtractBudget`)である。小さく偽った zip はエントリが読めずに
 * 落ちるか、実測予算で止まる。この 2 段構えは既存の資源上限と同じ流儀。
 */
export function assertDeclaredEntryCount(zip: Buffer): void {
  // EOCD は末尾から後方走査する(zip 仕様どおり最後に見つかったものが本物)。前方走査だと
  // コメント欄に仕込んだ偽シグネチャを掴む。
  const minStart = Math.max(0, zip.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = zip.length - 22; i >= minStart; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw validation('プロジェクト zip の形式が不正です');

  let entries = zip.readUInt16LE(eocd + 10);
  let cdBytes = zip.readUInt32LE(eocd + 12);
  if (entries === 0xffff || cdBytes === 0xffffffff) {
    // ZIP64: EOCD ロケータ(0x07064b50)→ ZIP64 EOCD(0x06064b50)を辿って 64bit 値を読む。
    const locator = eocd - 20;
    if (locator < 0 || zip.readUInt32LE(locator) !== 0x07064b50) {
      throw validation('プロジェクト zip の形式が不正です');
    }
    const z64 = Number(zip.readBigUInt64LE(locator + 8));
    if (!Number.isSafeInteger(z64) || z64 < 0 || z64 + 56 > zip.length) {
      throw validation('プロジェクト zip の形式が不正です');
    }
    if (zip.readUInt32LE(z64) !== 0x06064b50) {
      throw validation('プロジェクト zip の形式が不正です');
    }
    entries = Number(zip.readBigUInt64LE(z64 + 32));
    cdBytes = Number(zip.readBigUInt64LE(z64 + 40));
  }
  if (entries > MAX_ENTRY_COUNT) {
    throw validation(`プロジェクト zip のファイル数が多すぎます(上限 ${MAX_ENTRY_COUNT} 件)`);
  }
  if (cdBytes > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw validation('プロジェクト zip の目録が大きすぎます');
  }
}

/** 展開中に残り何バイト書いてよいか。全エントリで 1 つを共有する。 */
interface ExtractBudget {
  remaining: number;
}

/**
 * 予算超過を `pipeline` の外へ運ぶ番兵。stream の `destroy` 経路は `Error` を前提にするため
 * `AppError`(plain object)をそのまま流さず、外側で `validation` へ翻訳する。
 */
class ExtractBudgetExceeded extends Error {}

/**
 * 実測で許す展開後バイト数。絶対上限と圧縮比上限のうち厳しい方を採る。圧縮比側に
 * `COMPRESSION_RATIO_FLOOR_BYTES` の下駄を残すのは、繰り返しの多い小さな HTML が正当でも
 * 容易に 100 倍を超えるため(前段の申告値検査と同じ理由)。
 */
export function extractByteBudget(zipBytes: number): number {
  const ratioCap = Math.max(COMPRESSION_RATIO_FLOOR_BYTES, zipBytes * MAX_COMPRESSION_RATIO);
  return Math.min(MAX_UNCOMPRESSED_BYTES, ratioCap);
}

/**
 * 1 エントリを予算を数えながら書き出す。`archive.extract` を使わないのは、あちらが
 * 「書いた量」を観測させないため — 申告値を偽った zip を止められるのは、inflate 出力を
 * 通過するチャンクを自分で数える経路だけ。超過時は書きかけのファイルが残るが、呼び出し側が
 * 展開ディレクトリごと `cleanupProject` する。
 */
async function extractEntry(
  archive: InstanceType<typeof StreamZip.async>,
  entry: StreamZip.ZipEntry,
  dest: string,
  budget: ExtractBudget,
): Promise<void> {
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      budget.remaining -= chunk.length;
      if (budget.remaining < 0) {
        cb(new ExtractBudgetExceeded());
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(await archive.stream(entry), meter, createWriteStream(dest));
  } catch (e) {
    if (e instanceof ExtractBudgetExceeded) {
      const limitMb = Math.floor(MAX_UNCOMPRESSED_BYTES / (1024 * 1024));
      throw validation(
        `プロジェクト zip の展開後サイズが大きすぎます(上限 ${limitMb} MB / 圧縮比 ${MAX_COMPRESSION_RATIO} 倍)`,
      );
    }
    throw e;
  }
}

/**
 * アップロードされた vivliostyle プロジェクト zip を新規 temp ディレクトリへ展開する。
 * ライフサイクルは呼び出し側が持ち、完了時(PDF を読んだ後、またはプレビューセッション
 * 停止時)に `cleanupProject(dir)` を呼ばねばならない。
 *
 * 圧縮後サイズの上限は上流のボディパーサ(→ 413)が強制する。展開後の総量・件数・圧縮比は
 * 上流からは見えないため `assertWithinExtractLimits` がここで受け持つ(→ 400)。
 */
export async function extractProjectZip(zip: Buffer): Promise<ExtractedProject> {
  if (zip.length === 0) throw validation('プロジェクト zip が空です');
  // materialize(`archive.entries()`)の**前**に申告値で足切りする。
  assertDeclaredEntryCount(zip);

  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(config.tmpDir, `vivlio-${stamp}`);
  const zipPath = `${dir}.zip`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(zipPath, zip);

  let fileCount = 0;
  try {
    const archive = new StreamZip.async({ file: zipPath });
    try {
      const entries = await archive.entries();
      // zip-slip 検証を全件先に済ませ(防御を維持し早期失敗)、各 entry の出力先を確定する。
      // 分類は**正規化後の相対パス**に対して行う(生の名前で見ると `x.png/../y.js` が抜ける)。
      const targets: { entry: StreamZip.ZipEntry; dest: string }[] = [];
      for (const entry of Object.values(entries)) {
        const dest = safeEntryPath(dir, entry.name);
        const rel = path.relative(dir, dest).split(path.sep).join('/');
        if (entry.isDirectory) {
          // ディレクトリ名も同じ規則で見る(`node_modules/` の作成自体を塞ぐ)。
          if (!isIgnorableEntry(rel) && isNpmArtifact(rel)) {
            throw validation(`このディレクトリは取り込めません: ${entry.name}`);
          }
          continue;
        }
        if (isIgnorableEntry(rel)) continue;
        if (!isAllowedEntryName(rel)) {
          throw validation(
            `このファイルは取り込めません: ${entry.name}。` +
              `取り込めるのは ${[...ALLOWED_EXTENSIONS].join(' ')} だけです`,
          );
        }
        targets.push({ entry, dest });
      }
      // 1 バイトも書く前に資源上限を検査する(zip bomb)。ignore 分は書かないので数えない。
      assertWithinExtractLimits(
        zip.length,
        targets.map((t) => t.entry.size),
      );
      // 親ディレクトリは重複排除して一括作成する(ファイルごとの mkdir 重複呼び出しを避ける)。
      const parents = [...new Set(targets.map((t) => path.dirname(t.dest)))];
      await Promise.all(parents.map((d) => fs.mkdir(d, { recursive: true })));
      // 展開を同時実行上限付きで並列化する。単一 zip ハンドルからの同時 extract は安全:
      // 各 entry stream は明示 position(`fs.read` の position 引数)で読み、共有 fd の現在
      // 位置に依存しないため互いに干渉しない(node-stream-zip `EntryDataReaderStream`)。
      const budget: ExtractBudget = { remaining: extractByteBudget(zip.length) };
      await mapLimit(targets, EXTRACT_CONCURRENCY, (t) =>
        extractEntry(archive, t.entry, t.dest, budget),
      );
      fileCount = targets.length;
    } finally {
      // アップロード実体(最大 `maxProjectBytes`)は拒否した時ほど確実に消す必要がある。
      // `close()` の失敗で削除まで巻き添えにすると、弾いたはずの zip が temp に積み上がり、
      // それ自体がディスク枯渇の経路になる。close の失敗は握り潰し、削除は必ず試す。
      await archive.close().catch(() => undefined);
      await fs.rm(zipPath, { force: true });
    }

    if (fileCount === 0) throw validation('プロジェクト zip にファイルがありません');

    // temp ディレクトリはこのリポジトリ配下にあり、その package.json は "type":"module"。
    // 最近傍 package.json 解決がリポジトリ側まで登らないよう、プロジェクトが同梱しない場合は
    // ルートへ空の package.json を置いて解決をここで止める(展開物がリポジトリの module 設定を
    // 引き継がないようにする)。zip 同梱の `package.json` は拡張子許可リスト側で拒否済み
    // なので、ここで置くのは常に我々の空ファイルである。
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) await fs.writeFile(pkg, '{}\n', 'utf8');

    const configPaths = await findConfigFiles(dir);
    // 2 件以上は 400。以前は BFS 順の最初の 1 件を黙って採っていたため、深い所に別の
    // config を隠して「どちらが効くか」を人間に判らなくできた。曖昧なら拒否へ倒す。
    if (configPaths.length > 1) {
      throw validation('vivliostyle.config.json が複数あります。1 つにしてください');
    }
    const parsed =
      configPaths.length === 1
        ? parseProjectConfig(await fs.readFile(configPaths[0], 'utf8'), dir)
        : undefined;
    // ⚠ zip 経路には `docAssets.stageDocAssets` を**掛けない**(コードを読んで確認した
    // 上での判断)。zip は外部クライアントが送ってくる自己完結のプロジェクトで、CSS も
    // フォントもアーカイブ自身が同梱する。我々の per-fund CSS と共通フォントを他人の
    // プロジェクトへ混ぜ込む理由が無く、同名衝突で相手の資産を隠す副作用だけが残る。
    // テンプレ JS が要るのは editor 自身のテンプレ(inline / merge / preview-inline)であって
    // zip 側ではない — zip の**外部** `.js` は拡張子許可リストが拒否する。
    // ⚠ zip の `.html` に直接書かれた**インライン script は、build 経路では実行される**。
    // `previewProxy.CONTENT_CSP` の `script-src 'none'` はプレビュー中継の応答ヘッダであって、
    // `POST /api/build/project` の組版(headless で直接読む)には掛からない
    // (OpenAPI の `/build/project` 説明が正しく「組版時に実行される」と書いている)。
    // これを受けるのは CSP ではなく、egress 遮断(そのビルド専用オリジンのみ中継)と
    // 作業ディレクトリの封じ込めである。
    //
    // CSS の外部参照はここで拒む。zip 経路はリクエスト本文に CSS が現れないため
    // build 入口の `assertNoDocumentExternalRefs` では掴まらず、展開直後が唯一の関所になる
    // (build も project プレビューもこのディレクトリを見る)。
    await assertProjectDirHasNoExternalRefs(dir);
    return { dir, config: parsed, fileCount, docBase: parsed?.base ?? DEFAULT_DOC_BASE };
  } catch (e) {
    // 中途展開のディレクトリを決して漏らさない(例: zip-slip エントリ拒否時)。
    await cleanupProject(dir);
    // 破損または悪意あるアーカイブは不正入力 → 500 ではなく 400。node-stream-zip は独自の
    // "Malicious entry" ガードを上げるため、その種の失敗はすべて validation として表面化する。
    if (isAppError(e)) throw e;
    throw validation('プロジェクト zip の展開に失敗しました', { cause: e });
  }
}

/** 展開済みプロジェクトディレクトリを削除する(ベストエフォート)。 */
export async function cleanupProject(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 展開ツリー内の `vivliostyle.config.json` を**すべて**探す(浅い順)。照合は小文字化して
 * 行う — 探して検証する側は fold して広く拾うのが正しい(`vivliostyle.config.JSON` を
 * 見落とすと、我々が検証しないまま zip に残る)。CLI は `configData` 経路で動くので、
 * ここで拾った以外のファイルを CLI が読み直すことは無い。
 */
async function findConfigFiles(root: string): Promise<string[]> {
  const queue: string[] = [root];
  const found: string[] = [];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (isConfigFileName(e.name)) found.push(full);
    }
  }
  return found;
}
