// =============================================================================
// test_batch.ts — 全サンプル(samples.json の全件)の SVG を一括再生成し比較ビューアを作る
// -----------------------------------------------------------------------------
// 出力:
//   out/svg_js/<name>.svg ... 各サンプルの SVG
//   out/compare.html      ... ブラウザで一覧確認できるビューア
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInputData, samples as jsSamples } from './input/load.js';
import { renderPdfStylePieToSvg } from './svg_export/pipeline.js';
import { escapeXml } from './svg_export/rendering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本ファイルは src/ にあるため、1 つ上(pie-chart ルート)を基準に out/ を解決する。
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);
const outRoot = path.resolve(projectRoot, 'out');

interface RenderResultStatus {
  status: 'ok' | 'error';
  error?: string;
}

function generateHtml(
  allNames: string[],
  jsResults: Record<string, RenderResultStatus>,
  timestamp: string,
  aspectRatio: number,
): string {
  const jsOk = Object.values(jsResults).filter((r) => r.status === 'ok').length;
  const jsTotal = Object.keys(jsResults).length;

  const samplesPerPage = 12;
  const pages: string[][] = [];
  for (let i = 0; i < allNames.length; i += samplesPerPage) {
    pages.push(allNames.slice(i, i + samplesPerPage));
  }

  const renderCell = (name: string) => {
    const jr = jsResults[name];
    if (!jr) {
      return `<div class="sample"><div class="name">${escapeXml(name)}</div>
        <div class="error-msg">生成されていません</div></div>`;
    }
    if (jr.status === 'error') {
      return `<div class="sample error"><div class="name">${escapeXml(name)}</div>
        <div class="error-msg">ERROR<br><small>${escapeXml(jr.error ?? '')}</small></div></div>`;
    }
    return `<div class="sample"><div class="name">○${escapeXml(name)}</div>
      <div class="svg-wrap"><object type="image/svg+xml" data="svg_js/${encodeURIComponent(name)}.svg" aria-label="${escapeXml(name)}"></object></div></div>`;
  };

  const pagesHtml = pages
    .map(
      (pageNames, idx) => `
  <div class="page">
    <div class="page-header">A4 プレビュー — Page ${idx + 1} / ${pages.length}</div>
    <div class="grid">
      ${pageNames.map(renderCell).join('\n      ')}
    </div>
  </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=210mm, initial-scale=1.0">
  <title>SVG ビューア — A4 プレビュー (pie-chart)</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: "Yu Gothic", "Meiryo", sans-serif; background: #888; }
    .toolbar { position: sticky; top: 0; z-index: 10; background: #444; color: #fff;
               padding: 6px 12px; font-size: 0.8rem; display: flex; gap: 12px;
               align-items: center; flex-wrap: wrap; }
    .toolbar strong { color: #fff; }
    .pages-area { padding: 8mm 0; }
    .page { width: 210mm; height: 297mm; background: #fff;
            margin: 0 auto 8mm; padding: 12mm;
            box-shadow: 0 2px 10px rgba(0,0,0,0.35);
            page-break-after: always; overflow: hidden; }
    .page-header { font-size: 9pt; color: #555; border-bottom: 1px solid #888;
                   padding-bottom: 2mm; margin-bottom: 4mm; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr);
            column-gap: 3mm; row-gap: 6mm; }
    .sample { text-align: center; min-width: 0; }
    .sample .name { font-size: 8pt; color: #222; margin-bottom: 1.5mm;
                    word-break: break-all; line-height: 1.25; min-height: 2.4em; }
    .sample .svg-wrap { width: 100%; line-height: 0; }
    .sample object { width: 100%; height: auto; display: block;
                     aspect-ratio: ${aspectRatio.toFixed(6)}; }
    .sample.error .name { color: #c00; }
    .error-msg { color: #c00; font-size: 7.5pt; padding: 4mm;
                 border: 1px dashed #c99; border-radius: 2px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>SVG ビューア (pie-chart) — A4 プレビュー</strong>
    <span style="margin-left:auto">SVG: ${jsOk}/${jsTotal} OK ／ ${samplesPerPage} 件/ページ × ${pages.length} ページ ／ ${timestamp}</span>
  </div>
  <div class="pages-area">${pagesHtml}</div>
</body>
</html>`;
}

async function main(): Promise<void> {
  const timestamp = new Date().toLocaleString('ja-JP');

  const jsDir = path.join(outRoot, 'svg_js');
  fs.mkdirSync(jsDir, { recursive: true });
  // 生成前に既存 SVG を消す。残しておくと、レンダーに失敗したサンプルや samples.json から
  // 消えたサンプルの**前回の出力**がそのまま残り、後続の `batch:diff` が baseline と一致する
  // ものとして OK を返す。byte-diff は「今のコードが出したバイト列」を見るための装置なので、
  // 出力ディレクトリは毎回この実行の生成物だけを含む状態にする。
  for (const f of fs.readdirSync(jsDir)) {
    if (f.endsWith('.svg')) fs.rmSync(path.join(jsDir, f));
  }

  const jsResults: Record<string, RenderResultStatus> = {};
  const jsSampleEntries = Object.entries(jsSamples);
  console.log(`\n[Step] SVG 生成 (${jsSampleEntries.length} 件)`);
  let svgAspectRatio: number | null = null;
  for (const [name, entry] of jsSampleEntries) {
    const outFile = path.join(jsDir, `${name}.svg`);
    try {
      const items = resolveInputData({ data: entry.items });
      const { svg, config: cfg } = await renderPdfStylePieToSvg(items, {});
      fs.writeFileSync(outFile, svg, 'utf-8');
      jsResults[name] = { status: 'ok' };
      if (svgAspectRatio === null) {
        svgAspectRatio = cfg.fixedSvgWidthMm / cfg.fixedSvgHeightMm;
      }
      console.log(`  [JS OK] ${name}`);
    } catch (e: any) {
      jsResults[name] = { status: 'error', error: e.message };
      console.error(`  [JS ERR] ${name}: ${e.message}`);
    }
  }

  const allNames = Object.keys(jsSamples);
  const html = generateHtml(allNames, jsResults, timestamp, svgAspectRatio ?? 1);
  const htmlPath = path.join(outRoot, 'compare.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const jsOk = Object.values(jsResults).filter((r) => r.status === 'ok').length;
  const jsErr = jsSampleEntries.length - jsOk;

  console.log('\n=== Summary ===');
  console.log(`SVG: ${jsOk}/${jsSampleEntries.length} OK${jsErr ? `  (${jsErr} errors)` : ''}`);
  console.log(`Viewer: ${htmlPath}`);

  // 1 件でも生成に失敗したら非 0 で終える。compare.html は失敗も表示するので書き出してから
  // 落とす。ここが 0 のままだと `npm run batch && npm run batch:diff` の連結で失敗が握り潰され、
  // 「生成できなかった」が「差分が無い」と同じ結果に見える。
  if (jsErr > 0) {
    console.error(`[batch] ${jsErr} 件の生成に失敗しました`);
    process.exitCode = 1;
  }
}

main().catch((err: any) => {
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});
