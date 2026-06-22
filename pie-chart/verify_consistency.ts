// =============================================================================
// verify_consistency.ts — 「配置判断の採点 (実描画基準) ↔ emit された実 SVG」の一致テスト。
// -----------------------------------------------------------------------------
// 目的: cascadeWithSonohokaPick 等の配置選択が使う内部スコアラ countDefects と、実際に出力される
// SVG の幾何がズレない (= 判断が実描画基準である) ことを全サンプルで自動検証する。ズレると、過去
// asset_11 で起きた「採点と実描画の乖離による誤配置」が再発し得るため、その回帰ガードとなる。
//
// 方式: 各サンプルを再レンダリングし、内部スコア (diagnostics.finalScore = 最終配置を countDefects
// で数えた値) と、emit された SVG から抽出した leader 点列を **同一述語** (pathsCross /
// distPointToSegment, 本体から import) で数えた値を突き合わせる。leader crossings / 円内貫通(pie)
// は selection が直接依存するメトリクスなので厳密一致をアサートする。clips は幅オラクル共有
// (verify_svg の assertOracleSync) と npm run verify が emit SVG 上で担保するため情報出力のみ。
//   実行: npm run verify:consistency
// =============================================================================

import { resolveInputData, samples as jsSamples } from './src/data.js';
import { renderPdfStylePieToSvg, pathsCross, distPointToSegment } from './src/svg_export/index.js';

type Pt = { x: number; y: number };

/** emit SVG から leader (fill="none" の path) の点列を全て抽出する。skip された leader は出力に
 *  含まれないので自然に除外される (= realLeaderPaths の null と対応)。 */
function parseLeaders(svg: string): Pt[][] {
  const leaders: Pt[][] = [];
  for (const m of svg.matchAll(/<path d="([^"]+)" fill="none"/g)) {
    const pts: Pt[] = [];
    for (const c of m[1].matchAll(/[ML]([\d.\-]+),([\d.\-]+)/g)) {
      pts.push({ x: parseFloat(c[1]), y: parseFloat(c[2]) });
    }
    if (pts.length >= 2) leaders.push(pts);
  }
  return leaders;
}

/** 最初のスライス path "M cx,cy L.. A r,.." から円の中心・半径を取る (verify_svg.parsePieGeometry と同式)。 */
function parsePie(svg: string): { cx: number; cy: number; r: number } | null {
  const m = svg.match(/<path d="M([\d.\-]+),([\d.\-]+) L[\d.\-]+,[\d.\-]+ A([\d.\-]+),/);
  if (!m) return null;
  return { cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(m[3]) };
}

function countParsedCrossings(leaders: Pt[][]): number {
  let c = 0;
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      if (pathsCross(leaders[i], leaders[j])) c += 1;
    }
  }
  return c;
}

/** countDefects.pie と同条件: 中心までの最短距離 < r-1 の segment を 1 本でも持つ leader を数える。 */
function countParsedPie(leaders: Pt[][], pie: { cx: number; cy: number; r: number }): number {
  let pieCount = 0;
  for (const pts of leaders) {
    for (let k = 0; k + 1 < pts.length; k += 1) {
      if (
        distPointToSegment(pie.cx, pie.cy, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <
        pie.r - 1
      ) {
        pieCount += 1;
        break;
      }
    }
  }
  return pieCount;
}

interface Diverge {
  name: string;
  metric: string;
  internal: number;
  emitted: number;
}

async function main(): Promise<void> {
  const entries = Object.entries(jsSamples);
  const diverges: Diverge[] = [];
  let checked = 0;
  let clipsTotal = 0;

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  scorer ↔ emit SVG consistency  (${entries.length} samples)`);
  console.log(`${'─'.repeat(72)}`);

  for (const [name, entry] of entries) {
    const items = resolveInputData({ data: (entry as { items: unknown }).items });
    const { svg, diagnostics } = await renderPdfStylePieToSvg(items, {});
    const fs = diagnostics?.finalScore;
    if (!fs) continue; // 単一スライス等 finalScore 無しはスキップ
    checked += 1;
    clipsTotal += fs.clips;

    const pie = parsePie(svg);
    if (!pie) continue;
    const leaders = parseLeaders(svg);
    const emittedCross = countParsedCrossings(leaders);
    const emittedPie = countParsedPie(leaders, pie);

    if (fs.crossings !== emittedCross) {
      diverges.push({ name, metric: 'crossings', internal: fs.crossings, emitted: emittedCross });
    }
    if (fs.pie !== emittedPie) {
      diverges.push({ name, metric: 'pie', internal: fs.pie, emitted: emittedPie });
    }
  }

  console.log(`  checked: ${checked} samples  (clips 合計 internal=${clipsTotal} は情報のみ)`);
  if (diverges.length === 0) {
    console.log(`  ✓ 採点 (countDefects) と emit SVG の leader 幾何が全サンプルで一致`);
    console.log(`${'─'.repeat(72)}\n`);
    return;
  }
  console.log(`  ✖ DIVERGE ${diverges.length} 件 (採点が実描画と乖離):`);
  for (const d of diverges) {
    console.log(`    [DIVERGE] ${d.name}: ${d.metric} internal=${d.internal} emitted=${d.emitted}`);
  }
  console.log(`${'─'.repeat(72)}\n`);
  process.exit(1);
}

main();
