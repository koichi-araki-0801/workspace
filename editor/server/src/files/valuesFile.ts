// =============================================================================
// valuesFile.ts — 編集タブの値ファイル(`<dataRoot>/json/<ID>.json`)の読み取り
// =============================================================================
// 役割: 編集タブでパーツを挿入するとき、そのテンプレートの値で Jinja を描画する。値は別ツールが
// 置く `json/<4 区切りの ID>.json` で、ここは読むだけ(書き込みは持たない)。
// パスの検査は解決関数に内蔵し、呼び出し側が検査を忘れても dataRoot の外を読めないようにする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertTemplateId, type TemplateValues, validation } from '@editor/shared';
import { SampleData } from '@editor/shared/schemas';
import { config } from '../config.js';

/**
 * 値ファイル 1 本の上限バイト数。読み側は `JSON.parse` で全体を 1 度に構造化するので、
 * サイズを見ずに読むと巨大ファイル 1 本で全 GET が止まる。`fs.stat` で先に見て、超えたら読まない。
 */
const MAX_VALUES_BYTES = 5 * 1024 * 1024;

/** 4 区切りの ID を安全なファイル名に限定して解決する(パストラバーサル防止)。 */
function fileFor(templateId: string): string {
  return path.join(config.jsonDir, `${assertTemplateId(templateId)}.json`);
}

/**
 * ID の値ファイルを読む。無ければ `{ found: false, values: {} }`(エラーにしない)。
 * 上限超過・JSON として壊れている・`SampleData`(object)として不正なものは validation で拒む。
 * ENOENT 以外の I/O 失敗は「無い」と取り違えないよう、そのまま投げる。
 */
export async function readTemplateValues(templateId: string): Promise<TemplateValues> {
  const file = fileFor(templateId);
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { found: false, values: {} };
    throw e;
  }
  if (size > MAX_VALUES_BYTES) {
    throw validation(`値ファイルが大きすぎます(上限 ${MAX_VALUES_BYTES} バイト): ${templateId}`);
  }
  const raw = await fs.readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validation(`値ファイルが JSON として読めません: ${templateId}`);
  }
  const checked = SampleData.safeParse(parsed);
  if (!checked.success) {
    throw validation(`値ファイルのトップレベルが object ではありません: ${templateId}`);
  }
  return { found: true, values: checked.data };
}
