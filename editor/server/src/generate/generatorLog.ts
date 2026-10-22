// =============================================================================
// generatorLog.ts — 生成器の実行ログから今回の追記分を読み、書いたファイルの名前を取り出す
// =============================================================================
// 生成器は実行ログに `[OUTPUT] <ファイル名>` の行を追記する。ログは実行をまたいで同じ
// ファイルへ足されるので、起動前の長さを控えておき、今回の追記分だけを読む。前回までの
// 行を拾うと、今回書かれていないファイルを生成物と取り違える。
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/** 生成物のファイル名を知らせる行の印(末尾の空白を含む)。 */
export const OUTPUT_MARKER = '[OUTPUT] ';

/** 今回の追記分として読む上限(これを超えるログは異常として扱う)。 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 実行ログのパス。スクリプトの 1 つ上の階層の `log/` に、`build_<会社>_<ファンド>_<基準日>.log` で
 * 置かれる。名前の頭はスクリプトのファイル名ではなく生成器が決めた固定の `build_`。
 */
export function generatorLogPath(
  script: string,
  rep1CompanyCode: string,
  fundCode: string,
  baseDate: string,
): string {
  const dir = path.join(path.dirname(path.dirname(path.resolve(script))), 'log');
  return path.resolve(dir, `build_${rep1CompanyCode}_${fundCode}_${baseDate}.log`);
}

function logError(file: string, reason: string): Error {
  return new Error(`実行ログ ${path.basename(file)} ${reason}`);
}

/**
 * 起動前のログの長さ。ログが無ければ 0。あっても通常のファイルでなければ、追記分を正しく
 * 読めないので投げる。
 */
export async function logSizeBefore(file: string): Promise<number> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw logError(file, `を確かめられませんでした: ${(e as Error).message}`);
  }
  if (!st.isFile()) throw logError(file, 'が通常のファイルではありません');
  return st.size;
}

/**
 * 起動前の長さ `sizeBefore` より後ろの追記分を文字列で返す。ログが縮んでいたら(作り直された)
 * 全体を読む。無い・増えていない・上限超過・UTF-8 でないときは投げる。
 */
export async function readRunLog(
  file: string,
  sizeBefore: number,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw logError(file, 'が見つかりません');
    throw logError(file, `を開けませんでした: ${(e as Error).message}`);
  }
  try {
    const { size } = await handle.stat();
    const start = size < sizeBefore ? 0 : sizeBefore;
    const length = size - start;
    if (length <= 0) throw logError(file, 'に今回の追記がありません');
    if (length > maxBytes) throw logError(file, `の追記分が上限(${maxBytes} バイト)を超えています`);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    if (bytesRead !== length) throw logError(file, 'を最後まで読めませんでした');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw logError(file, 'を UTF-8 として読めません');
    }
    return start === 0 ? text.replace(/^\uFEFF/, '') : text;
  } finally {
    await handle.close();
  }
}

/**
 * ログの本文から `[OUTPUT] ` の印の後ろをファイル名として取り出す(重複は最初の位置の 1 つ)。
 * 印の後ろが空の行は、生成器の出力として壊れているので投げる。
 */
export function parseOutputNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf(OUTPUT_MARKER);
    if (at < 0) continue;
    const name = line.slice(at + OUTPUT_MARKER.length).trim();
    if (name === '')
      throw new Error(`実行ログの ${OUTPUT_MARKER.trim()} 行にファイル名がありません`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
