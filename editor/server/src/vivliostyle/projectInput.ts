// =============================================================================
// projectInput.ts — アップロード zip から vivliostyle プロジェクトを安全に展開する
// =============================================================================
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAppError, validation } from '@editor/shared';
import StreamZip from 'node-stream-zip';
import { config } from '../config.js';

/** アップロード zip から展開した vivliostyle プロジェクト。 */
export interface ExtractedProject {
  /** 展開ファイルを格納するルートディレクトリ。`cleanupProject` で削除する。 */
  dir: string;
  /** `vivliostyle.config.*` の絶対パス(存在すれば優先エントリ)。 */
  configPath?: string;
  /** 書き出したファイル数。 */
  fileCount: number;
}

const CONFIG_NAMES = new Set([
  'vivliostyle.config.js',
  'vivliostyle.config.cjs',
  'vivliostyle.config.mjs',
]);

// zip 展開の同時実行上限。多ファイルのプロジェクトで逐次 await の累積待ちを抑えつつ、
// fd/メモリの過負荷を避けるための上限。
const EXTRACT_CONCURRENCY = 8;

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
 * アップロードされた vivliostyle プロジェクト zip を新規 temp ディレクトリへ展開する。
 * ライフサイクルは呼び出し側が持ち、完了時(PDF を読んだ後、またはプレビューセッション
 * 停止時)に `cleanupProject(dir)` を呼ばねばならない。
 *
 * サイズ上限は通常 `express.raw({ limit })`(→ 413)が上流で強制する。ここの空アーカイブ
 * ガードは契約を明示的に保つためのもの。
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
      // 親ディレクトリは重複排除して一括作成する(ファイルごとの mkdir 重複呼び出しを避ける)。
      const parents = [...new Set(targets.map((t) => path.dirname(t.dest)))];
      await Promise.all(parents.map((d) => fs.mkdir(d, { recursive: true })));
      // 展開を同時実行上限付きで並列化する。単一 zip ハンドルからの同時 extract は安全:
      // 各 entry stream は明示 position(`fs.read` の position 引数)で読み、共有 fd の現在
      // 位置に依存しないため互いに干渉しない(node-stream-zip `EntryDataReaderStream`)。
      await mapLimit(targets, EXTRACT_CONCURRENCY, (t) => archive.extract(t.entry, t.dest));
      fileCount = targets.length;
    } finally {
      await archive.close();
      await fs.rm(zipPath, { force: true });
    }

    if (fileCount === 0) throw validation('プロジェクト zip にファイルがありません');

    // temp ディレクトリはこのリポジトリ配下にあり、その package.json は "type":"module"。
    // よって CommonJS の `module.exports` を使う `vivliostyle.config.js`(既定スキャフォルド)は
    // ESM として読み込みに失敗する。プロジェクト自身が package.json を同梱しない場合は、
    // ルートに CommonJS 既定の package.json を置き、Node の最近傍 package.json 解決が
    // `.js` を CommonJS に固定するようにする。
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) await fs.writeFile(pkg, '{}\n', 'utf8');

    const configPath = await findConfig(dir);
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
 * 展開ツリー内で最初の `vivliostyle.config.*` を浅い順に探す。フラットに zip された
 * プロジェクトも、単一トップレベルフォルダ配下のものも、どちらも動くようにする。
 */
async function findConfig(root: string): Promise<string | undefined> {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      else if (CONFIG_NAMES.has(e.name)) return full;
    }
  }
  return undefined;
}
