// =============================================================================
// batch_diff.mjs — `out/svg_js` と `out/_baseline` の SHA256 byte-diff 検証
// =============================================================================
// リファクタの挙動保証(出力バイト不変の鉄則)を機械化する。`npm run batch` で
// `out/svg_js` を再生成した後に実行し、baseline と 1 バイトでも違えば非 0 exit で
// 差分ファイル名を列挙する。比較は SVG のみ(compare.html は生成時刻を含むため対象外)。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(projectRoot, 'out', '_baseline');
const currentDir = path.join(projectRoot, 'out', 'svg_js');

/** ディレクトリ直下の .svg ファイル名一覧 (ソート済み) を返す。 */
function listSvgNames(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`[batch:diff] ディレクトリがありません: ${dir}`);
    process.exit(1);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.svg'))
    .sort();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const baseNames = listSvgNames(baselineDir);
const curNames = listSvgNames(currentDir);

// ── 1. ファイル集合の差 (追加/欠落はそれ自体が差分) ──
const baseSet = new Set(baseNames);
const curSet = new Set(curNames);
const missing = baseNames.filter((n) => !curSet.has(n)); // baseline にあって svg_js に無い
const extra = curNames.filter((n) => !baseSet.has(n)); // svg_js にあって baseline に無い

// ── 2. 共通ファイルの SHA256 比較 ──
const changed = baseNames.filter(
  (n) => curSet.has(n) && sha256(path.join(baselineDir, n)) !== sha256(path.join(currentDir, n)),
);

if (missing.length === 0 && extra.length === 0 && changed.length === 0) {
  console.log(`[batch:diff] OK — 全 ${baseNames.length} 件が baseline と byte 一致`);
  process.exit(0);
}

if (missing.length > 0)
  console.error(`[batch:diff] 欠落 (${missing.length}): ${missing.join(', ')}`);
if (extra.length > 0) console.error(`[batch:diff] 追加 (${extra.length}): ${extra.join(', ')}`);
if (changed.length > 0)
  console.error(`[batch:diff] 差分 (${changed.length}): ${changed.join(', ')}`);
console.error('[batch:diff] NG — 出力が baseline と一致しません (意図的な場合は baseline を更新)');
process.exit(1);
