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

/** アップロード zip から展開した vivliostyle プロジェクト。 */
interface ExtractedProject {
  /** 展開ファイルを格納するルートディレクトリ。`cleanupProject` で削除する。 */
  dir: string;
  /** `vivliostyle.config.*` の絶対パス(存在すれば優先エントリ)。 */
  configPath?: string;
  /** 書き出したファイル数。 */
  fileCount: number;
}

// vivliostyle CLI は config を「モジュールとして読み込む」= 中身の JS がこのプロセス
// (PDF ビルド worker)で実行される。アップロード zip は外部クライアントが任意に作れるため、
// 実行可能形式の config を受け入れることは任意コード実行を受け入れることと同義になる。
// よって受け付けるのは宣言的な JSON だけとし、実行可能形式は展開段階で 400 として弾く。
const DECLARATIVE_CONFIG_NAME = 'vivliostyle.config.json';

/**
 * 実行可能な config のファイル名。CLI 側の探索順(`.js .mjs .cjs .ts .mts .cts .json`)から
 * JSON を除いた全部。1 つでもツリーに残っていると、こちらが `configPath` を渡さなくても
 * CLI が cwd から自動発見して読み込むため、「使わない」ではなく「置かせない」で守る。
 */
const EXECUTABLE_CONFIG_NAMES = new Set([
  'vivliostyle.config.js',
  'vivliostyle.config.mjs',
  'vivliostyle.config.cjs',
  'vivliostyle.config.ts',
  'vivliostyle.config.mts',
  'vivliostyle.config.cts',
]);

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
  process.env.VIVLIO_MAX_UNZIP_BYTES,
  256 * 1024 * 1024,
);
/** 展開するファイル数の上限(inode / ディレクトリエントリの枯渇を防ぐ)。 */
const MAX_ENTRY_COUNT = envPositiveNumber(process.env.VIVLIO_MAX_UNZIP_ENTRIES, 5000);
/** 圧縮比(展開後合計 ÷ zip バイト数)の上限。 */
const MAX_COMPRESSION_RATIO = envPositiveNumber(process.env.VIVLIO_MAX_UNZIP_RATIO, 100);
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
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

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
      const targets = Object.values(entries)
        .filter((entry) => !entry.isDirectory)
        .map((entry) => ({ entry, dest: safeEntryPath(dir, entry.name) }));
      // 1 バイトも書く前に資源上限を検査する(zip bomb)。
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
    // 引き継がないようにする)。config の実行可能形式自体は `findConfig` が拒否する。
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) await fs.writeFile(pkg, '{}\n', 'utf8');

    const configPath = await findConfig(dir);
    if (configPath) assertSafeConfigBase(await fs.readFile(configPath, 'utf8'));
    return { dir, configPath, fileCount };
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
 * プレビューの CSP プロファイル判定(`previewProxy.VIEWER_PATH_PREFIXES`)がビューア側と
 * 見なす path 接頭辞。ここへ文書をマウントされると、アップロード由来の HTML が
 * `script-src 'unsafe-eval'` のビューアプロファイルで配信されてしまう。
 * `/node_modules` に末尾スラッシュを付けないのは、`base` が `/node_modules` なら配信 path が
 * `/node_modules/...` になり向こう側の判定に当たるため(こちらを広めに取る)。
 */
const RESERVED_CONFIG_BASES = ['/__vivliostyle-viewer', '/@', '/node_modules'];

/**
 * 宣言的 config の `base`(文書の配信 path)がビューア側の予約接頭辞を奪っていないか見る。
 *
 * `base` は CLI の正規フィールドで、config ファイル側の値が唯一の権威になる — inline config
 * の `base` は `mergeInlineConfig` が `inlineOptions` へ落とすだけで `config.base` を
 * 上書きしないため、サーバ側から固定できない。よって「ビューアの取り分を名乗る base だけ
 * 拒否する」形で入口を絞る。既定 `/vivliostyle` から変えること自体は許す — その場合の文書は
 * `previewProxy` の fail-close 既定で文書プロファイル(`script-src 'none'`)になる。
 *
 * JSON として読めない config はここでは判断せず素通しする(CLI 側が読めずに失敗する)。
 */
export function assertSafeConfigBase(configText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return;
  }
  const base = (parsed as { base?: unknown } | null)?.base;
  if (typeof base !== 'string') return;
  if (!RESERVED_CONFIG_BASES.some((p) => base.startsWith(p))) return;
  throw validation(`この base はプレビューの予約領域と衝突するため使えません: ${base}`);
}

/**
 * 展開ツリー内で最初の `vivliostyle.config.json` を浅い順に探す。フラットに zip された
 * プロジェクトも、単一トップレベルフォルダ配下のものも、どちらも動くようにする。
 * 実行可能形式の config を 1 つでも見つけたら、その時点で `validation` を投げて展開ごと
 * 拒否する(見つけた場所が浅いか深いかは問わない。CLI の自動発見も潰すため)。
 */
async function findConfig(root: string): Promise<string | undefined> {
  const queue: string[] = [root];
  let found: string | undefined;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(full);
      } else if (EXECUTABLE_CONFIG_NAMES.has(e.name)) {
        throw validation(
          `実行可能形式の設定ファイルは受け付けません: ${e.name}。${DECLARATIVE_CONFIG_NAME} を使うか、entry パラメータで入力ファイルを指定してください`,
        );
      } else if (e.name === DECLARATIVE_CONFIG_NAME && !found) {
        found = full;
      }
    }
  }
  return found;
}
