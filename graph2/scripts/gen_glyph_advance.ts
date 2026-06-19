// =============================================================================
// gen_glyph_advance.ts — 埋め込みフォント (fonts/BIZUDPGothic-{Regular,Bold}.woff2) の実
// glyph advance 幅をパースし、ウェイト別 (400/700) の非予測 codepoint→advance(em) 例外テーブルを
// src/glyph_advance.ts (GLYPH_ADVANCE_BY_WEIGHT) へ出力する。
// -----------------------------------------------------------------------------
// 幅モデルを「全角1.0/半角0.5」ヒューリスティックから実描画(実 advance)基準へ揃えるための
// 生成物。visualCharEm の heuristic 予測と一致する advance (例: 漢字=1.0) は省き、
// 異なるグリフのみを例外として持つ (BIZ UDPGothic はかな/英数がプロポーショナルのため
// かなも載り、'%' のような全角幅 ASCII も載る)。400 と 700 でプロポーショナルなかな/英数の
// advance が異なるため、ウェイトごとにテーブルを生成し visualCharEm が cfg.fontWeight で
// 引き分ける。フォントを差し替えたら本スクリプトを再実行する。
//   実行: npm run gen:widths
// WOFF/WOFF2 は fontverter で sfnt 化してから最小 TrueType パーサ
// (head/hhea/hmtx/cmap fmt4(3,1)+fmt12) で読む。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fontverter from 'fontverter';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'src', 'glyph_advance.ts');

// ウェイト → フォントファイル (config.ts の WEIGHT_FONT と一致させる)。
const WEIGHT_FONT: Record<string, string> = {
  '400': path.join(ROOT, 'fonts', 'BIZUDPGothic-Regular.woff2'),
  '700': path.join(ROOT, 'fonts', 'BIZUDPGothic-Bold.woff2'),
};

// svg_geom.ts visualCharEm のフォールバック heuristic と同じ予測値 (全角1.0/半角0.5)。
// テーブル未収録 codepoint はこの値が使われるため、予測と一致する advance は収録不要。
const heuristicEm = (cp: number): number => {
  if (cp >= 0x4e00 && cp <= 0x9fff) return 1;
  if (cp >= 0x3040 && cp <= 0x309f) return 1;
  if (cp >= 0x30a0 && cp <= 0x30ff) return 1;
  if (cp >= 0x3000 && cp <= 0x303f) return 1;
  if (cp >= 0xff01 && cp <= 0xff60) return 1;
  if (cp >= 0xffe0 && cp <= 0xffe6) return 1;
  if (cp === 0x25b3) return 1;
  return 0.5;
};

/** 1 フォントを読み、heuristic 予測と異なる advance(em) を持つ codepoint だけを列挙する。 */
async function parseFontEntries(
  fontPath: string,
): Promise<{ unitsPerEm: number; entries: [number, number][] }> {
  const raw = fs.readFileSync(fontPath);
  const magic = raw.toString('latin1', 0, 4);
  const b = magic === 'wOF2' || magic === 'wOFF' ? await fontverter.convert(raw, 'sfnt') : raw;
  const u16 = (o: number) => b.readUInt16BE(o);
  const u32 = (o: number) => b.readUInt32BE(o);

  const numTables = u16(4);
  const tbl: Record<string, number> = {};
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    tbl[b.toString('latin1', o, o + 4)] = u32(o + 8);
  }

  const unitsPerEm = u16(tbl.head + 18);
  const numHM = u16(tbl.hhea + 34);
  const hmtx = tbl.hmtx;
  const advEm = (gid: number) => u16(hmtx + Math.min(gid, numHM - 1) * 4) / unitsPerEm;

  // cmap: format 4 (3,1) を主、format 12 を補助として全マップ codepoint を列挙する。
  const cmapOff = tbl.cmap;
  const nSub = u16(cmapOff + 2);
  const subs: { pid: number; eid: number; off: number; fmt: number }[] = [];
  for (let i = 0; i < nSub; i += 1) {
    const o = cmapOff + 4 + i * 8;
    const off = cmapOff + u32(o + 4);
    subs.push({ pid: u16(o), eid: u16(o + 2), off, fmt: u16(off) });
  }
  const f4 = subs.find((s) => s.pid === 3 && s.eid === 1 && s.fmt === 4);
  const f12 = subs.find((s) => s.fmt === 12);

  const codeToGid = new Map<number, number>();
  if (f4) {
    const base = f4.off;
    const segX2 = u16(base + 6);
    const segCount = segX2 / 2;
    const endO = base + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < segCount; s += 1) {
      const end = u16(endO + s * 2);
      const st = u16(startO + s * 2);
      const delta = u16(deltaO + s * 2);
      const ro = u16(rangeO + s * 2);
      for (let cp = st; cp <= end && cp !== 0xffff; cp += 1) {
        let gid: number;
        if (ro === 0) gid = (cp + delta) & 0xffff;
        else {
          const gi = u16(rangeO + s * 2 + ro + (cp - st) * 2);
          gid = gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        if (gid !== 0) codeToGid.set(cp, gid);
      }
    }
  }
  if (f12) {
    const base = f12.off;
    const nGroups = u32(base + 12);
    for (let g = 0; g < nGroups; g += 1) {
      const o = base + 16 + g * 12;
      const start = u32(o);
      const end = u32(o + 4);
      const sg = u32(o + 8);
      for (let cp = start; cp <= end; cp += 1) {
        if (!codeToGid.has(cp)) codeToGid.set(cp, sg + (cp - start));
      }
    }
  }

  // heuristic 予測と異なる advance の codepoint のみ例外として記録 (4 桁丸め)。
  // 例: 漢字 (1.0=予測通り) は省き、プロポーショナルかなや全角幅の ASCII '%' は収録する。
  const entries: [number, number][] = [];
  for (const [cp, gid] of [...codeToGid.entries()].sort((a, b2) => a[0] - b2[0])) {
    const em = Math.round(advEm(gid) * 10000) / 10000;
    if (em !== heuristicEm(cp)) entries.push([cp, em]);
  }
  return { unitsPerEm, entries };
}

const blocks: string[] = [];
const summary: string[] = [];
for (const [weight, fontPath] of Object.entries(WEIGHT_FONT)) {
  const { unitsPerEm, entries } = await parseFontEntries(fontPath);
  const rel = path.relative(ROOT, fontPath).replace(/\\/g, '/');
  const lines = entries.map(([cp, em]) => `    [0x${cp.toString(16)}, ${em}],`);
  blocks.push(
    `  // ${rel} (unitsPerEm=${unitsPerEm}) / 収録数: ${entries.length}\n` +
      `  "${weight}": new Map<number, number>([\n${lines.join('\n')}\n  ]),`,
  );
  summary.push(`${weight}:${entries.length}`);
}

const out = `// AUTO-GENERATED by scripts/gen_glyph_advance.ts — DO NOT EDIT BY HAND.
// 埋め込みフォント (fonts/BIZUDPGothic-{Regular,Bold}.woff2) のウェイト別実 glyph advance(em)。
// visualCharEm の heuristic 予測 (全角1.0/半角0.5) と異なる codepoint のみ収録。
// フォント差し替え時は \`npm run gen:widths\` で再生成する。
export const GLYPH_ADVANCE_BY_WEIGHT: Record<string, ReadonlyMap<number, number>> = {
${blocks.join('\n')}
};
`;
fs.writeFileSync(OUT_PATH, out, 'utf-8');
console.log(`wrote ${OUT_PATH}: heuristic-diff entries by weight (${summary.join(', ')})`);
