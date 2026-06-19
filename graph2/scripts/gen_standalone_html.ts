// =============================================================================
// gen_standalone_html.ts — out/svg_js/*.svg を 1 枚に埋め込んだ自己完結 HTML を作る
// -----------------------------------------------------------------------------
// 出力: out/compare_standalone.html(SVG をすべてインライン化。単体で持ち出し可)
// 前提: `npm run batch` 済み(out/svg_js/<name>.svg が存在)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { samples as jsSamples } from '../src/data.js';
import { escapeXml } from '../src/svg_export/rendering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(__dirname, '..', 'out');
const jsDir = path.join(outRoot, 'svg_js');

const names = Object.keys(jsSamples);
const samplesPerPage = 12;
const pages: string[][] = [];
for (let i = 0; i < names.length; i += samplesPerPage) {
  pages.push(names.slice(i, i + samplesPerPage));
}

const renderCell = (name: string): string => {
  const svgPath = path.join(jsDir, `${name}.svg`);
  if (!fs.existsSync(svgPath)) {
    return `<div class="sample"><div class="name">${escapeXml(name)}</div>
      <div class="error-msg">生成されていません</div></div>`;
  }
  // インライン化: 幅 100% で収まるよう外側 width/height は CSS に委ねる
  // inline svg は UA 既定で overflow:hidden になり viewBox 境界 (y=0) でちょうど切るため、上端を
  // 天井に密着させた最上部ラベル (box top ≈ 0.8px) のグリフ上端が削れて見える。overflow:visible で
  // viewBox 外の僅かなはみ出しも描き、ビューア表示の見切れを防ぐ (実 SVG / PDF 出力には影響しない)。
  const svg = fs
    .readFileSync(svgPath, 'utf-8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<svg /, '<svg style="width:100%;height:auto;display:block;overflow:visible" ');
  return `<div class="sample"><div class="name">○${escapeXml(name)}</div>
    <div class="svg-wrap">${svg}</div></div>`;
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

const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=210mm, initial-scale=1.0">
  <title>SVG ビューア(自己完結) — graph2</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: "Yu Gothic", "Meiryo", sans-serif; background: #888; }
    .toolbar { position: sticky; top: 0; z-index: 10; background: #444; color: #fff;
               padding: 6px 12px; font-size: 0.8rem; }
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
    .error-msg { color: #c00; font-size: 7.5pt; padding: 4mm;
                 border: 1px dashed #c99; border-radius: 2px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>SVG ビューア(自己完結 / graph2)</strong>
    <span style="margin-left:12px">${names.length} 件 ／ ${samplesPerPage} 件/ページ × ${pages.length} ページ</span>
  </div>
  <div class="pages-area">${pagesHtml}</div>
</body>
</html>`;

const outPath = path.join(outRoot, 'compare_standalone.html');
fs.writeFileSync(outPath, html, 'utf-8');
const kb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(0);
console.log(`Wrote ${outPath} (${kb} KB, ${names.length} samples)`);
