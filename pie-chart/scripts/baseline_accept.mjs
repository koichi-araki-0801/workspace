// =============================================================================
// baseline_accept.mjs — `out/svg_js` を byte-diff の基準 `out/_baseline` として受理する
// =============================================================================
// `out/_baseline` はローカル生成物 (git 管理外) のため、clone 直後には存在しない。
// 初回セットアップと「意図的な出力変更の確定」の両方をこの 1 コマンドに正式化する
// (従来はオーナー環境の Claude フックによる暗黙コピーだけが生成手段だった)。
// 必ずコミット済みのクリーンな状態で実行すること — 未検証の変更を基準に凍結すると
// 以後の `npm run batch:diff` が退行を検出できなくなる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(projectRoot, 'out', '_baseline');
const currentDir = path.join(projectRoot, 'out', 'svg_js');

const svgCount = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).length : 0;

if (svgCount(currentDir) === 0) {
  console.error(`[baseline:accept] ${currentDir} に SVG がありません。先に \`npm run batch\` を実行してください`);
  process.exit(1);
}

fs.rmSync(baselineDir, { recursive: true, force: true });
fs.cpSync(currentDir, baselineDir, { recursive: true });
console.log(`[baseline:accept] out/_baseline を更新しました (${svgCount(baselineDir)} SVG)`);
