// =============================================================================
// leader_invariants.test.ts — 実レンダリングに対する leader 幾何の不変条件テスト
// -----------------------------------------------------------------------------
// 過去に「leader 交差」「leader の円内貫通」を出していた回帰サンプルと、健全な番兵
// サンプルを renderPdfStylePieToSvg で実際に描画し、出力 SVG の leader 折れ線が
//   1. 互いに交差しない
//   2. パイ円盤を貫かない (中心からの距離 ≥ r − 2px)
//   3. 曲がりは 1 回以内
// を満たすことを verify_svg.ts と同じ判定式で検査する。配置ロジックの変更でこれらの
// 性質が退行した場合に CI で検知する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { resolveInputData, samples } from '../src/input/load.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/index.js';
import { createPieLayoutConfig } from '../src/config.js';
import { visualCharEm } from '../src/svg_geom.js';

interface Pt {
  x: number;
  y: number;
}

/** verify_svg.ts と同じ leader 折れ線抽出 (<g class="label"> 内の fill="none" path)。 */
function parseLeaders(svg: string): { name: string; points: Pt[] }[] {
  const out: { name: string; points: Pt[] }[] = [];
  const groupRe = /<g class="label"([^>]*)>([\s\S]*?)<\/g>/g;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(svg)) !== null) {
    const name = gm[1].match(/\bdata-name="([^"]*)"/)?.[1] ?? '';
    const leaderM = gm[2].match(/<path d="([^"]+)" fill="none"[^>]*>/);
    if (!leaderM) continue;
    const points: Pt[] = [];
    for (const cmd of leaderM[1].matchAll(/[ML]([\d.\-]+),([\d.\-]+)/g)) {
      points.push({ x: parseFloat(cmd[1]), y: parseFloat(cmd[2]) });
    }
    if (points.length >= 2) out.push({ name, points });
  }
  return out;
}

function parsePie(svg: string): { cx: number; cy: number; r: number } {
  const m = svg.match(/<path d="M([\d.\-]+),([\d.\-]+) L[\d.\-]+,[\d.\-]+ A([\d.\-]+),/);
  if (!m) throw new Error('pie geometry not found');
  return { cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(m[3]) };
}

// 交差/最短距離の判定は本体実装 (`svg_geom.ts` / `leader_geometry.ts`) を import せず、
// テスト内の独立オラクルとして凍結複製する。本体と判定式を共有すると、本体の退行
// (tolerance の変更ミス・符号誤り等) をテストが同じ誤りで追認して検知できないため。

/** verify_svg.ts segmentsIntersect と同条件 (tolerance 0.5px・端点接触は交差としない)。 */
function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt, tolerance = 0.5): boolean {
  const cross = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (Math.abs(d1) <= tolerance) return false;
  if (Math.abs(d2) <= tolerance) return false;
  if (Math.abs(d3) <= tolerance) return false;
  if (Math.abs(d4) <= tolerance) return false;
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

// 引数は本体 (`leader_geometry.ts`) と同じ数値 6 個形式 (呼び出し箇所の書き換えを避ける)。
function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function leaderCrossings(leaders: { name: string; points: Pt[] }[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      const pa = leaders[i].points;
      const pb = leaders[j].points;
      for (let k = 0; k + 1 < pa.length; k += 1) {
        for (let m = 0; m + 1 < pb.length; m += 1) {
          if (segmentsIntersect(pa[k], pa[k + 1], pb[m], pb[m + 1])) {
            found.push(`${leaders[i].name} x ${leaders[j].name}`);
          }
        }
      }
    }
  }
  return found;
}

function pieIntrusions(
  leaders: { name: string; points: Pt[] }[],
  pie: { cx: number; cy: number; r: number },
  tolerancePx = 2,
): string[] {
  const found: string[] = [];
  for (const l of leaders) {
    for (let k = 0; k + 1 < l.points.length; k += 1) {
      const a = l.points[k];
      const b = l.points[k + 1];
      if (distPointToSegment(pie.cx, pie.cy, a.x, a.y, b.x, b.y) < pie.r - tolerancePx) {
        found.push(l.name);
        break;
      }
    }
  }
  return found;
}

// 過去に leader 交差 / 円内貫通を出していた回帰サンプル + 健全な番兵サンプル。
// 末尾 4 件は「その他」右上逃がしの短縮 (topRightLiftedRimDraft) の対象。
// 短い縦/斜め leader が円を貫かず交差しないことを固定する。
const REGRESSION_SAMPLES = [
  'stress_top_cluster_8',
  'currency_usd_heavy_9',
  'page16_country_allocation',
  'currency_gbca_pdf',
  'currency_many_small_10',
  'pdf_510037_07_fidelity_foreign_bond_country',
  'pdf_510037_05_global_reit_idx_country',
  'pdf_510037_05_global_reit_idx_currency',
  'pdf_510037_07_fidelity_foreign_bond_currency',
  'pdf_510037_02_world_bond_idx_currency',
] as const;
const SENTINEL_SAMPLES = [
  'stress_one_dominant_9',
  'ten_elements_balanced',
  'twelve_evenish',
] as const;

interface TextInfo {
  name: string;
  x: number;
  y: number;
  anchor: string;
  baseline: string;
  fontSize: number;
  nameScaleX: number;
  lineCount: number;
  lines: string[];
  inside: boolean;
}

/** <g class="label"> 内の <text>/<tspan> を抽出 (leader 有無は問わない)。 */
function parseTexts(svg: string): TextInfo[] {
  const out: TextInfo[] = [];
  const groupRe = /<g class="label"([^>]*)>([\s\S]*?)<\/g>/g;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(svg)) !== null) {
    const name = gm[1].match(/\bdata-name="([^"]*)"/)?.[1] ?? '';
    const nameScaleX = parseFloat(gm[1].match(/\bdata-name-scale-x="([^"]*)"/)?.[1] ?? '1');
    const lineCount = parseInt(gm[1].match(/\bdata-line-count="(\d+)"/)?.[1] ?? '1', 10);
    const textM = gm[2].match(
      /<text x="([\d.\-]+)" y="([\d.\-]+)" text-anchor="(\w+)" dominant-baseline="([\w-]+)"[^>]*font-size="([\d.]+)"/,
    );
    if (!textM) continue;
    const lines = [...gm[2].matchAll(/<tspan[^>]*>([^<]+)<\/tspan>/g)].map((m) => m[1]);
    out.push({
      name,
      x: parseFloat(textM[1]),
      y: parseFloat(textM[2]),
      anchor: textM[3],
      baseline: textM[4],
      fontSize: parseFloat(textM[5]),
      nameScaleX,
      lineCount,
      lines,
      inside: !gm[2].includes('fill="none"'),
    });
  }
  return out;
}

// verify_svg.ts の bbox 推定 (textBBox) を忠実に複製する。幅は本体 svg_geom.visualCharEm の実 glyph
// advance テーブルを直接引き、行高は config.lineHeightFactor。これにより本テストの "label inside pie"
// 判定が verify_svg と一致する (粗い em 近似だと 3/9 時付近のラベルで縦伸長を過大評価し誤検知する)。
const PIE_TEST_CFG = createPieLayoutConfig();
function visualLineUnits(text: string): number {
  let sum = 0;
  for (const ch of text) sum += visualCharEm(ch, PIE_TEST_CFG);
  return sum;
}

/** verify_svg.ts textBBox と同式の pixel テキスト box (charWidth=fontSize, lineH=fontSize*lineHeightFactor)。 */
function textBoxPx(t: TextInfo): { left: number; right: number; top: number; bottom: number } {
  const charWidth = t.fontSize * PIE_TEST_CFG.charWidthFactor;
  const totalH = t.fontSize * PIE_TEST_CFG.lineHeightFactor * t.lineCount;
  const sx = t.nameScaleX;
  let totalW: number;
  if (sx >= 1) {
    const lines = t.lineCount >= 2 ? t.lines : [t.lines.join('')];
    totalW = Math.max(...lines.map((s) => visualLineUnits(s))) * charWidth;
  } else {
    // 名前長体: 名前 (tspan[0]) は ×sx、% 部分 (残り tspan) は原寸。
    const name = t.lines[0] ?? '';
    const rest = t.lines.slice(1).join('');
    totalW =
      t.lineCount >= 2
        ? Math.max(visualLineUnits(name) * sx, visualLineUnits(rest)) * charWidth
        : (visualLineUnits(name) * sx + visualLineUnits(rest)) * charWidth;
  }
  const left = t.anchor === 'start' ? t.x : t.anchor === 'end' ? t.x - totalW : t.x - totalW / 2;
  // verify_svg と同じく text-after-edge のみ上端を totalH 引き上げ、他 (before-edge / middle) は top=y。
  const top = t.baseline === 'text-after-edge' ? t.y - totalH : t.y;
  return { left, right: left + totalW, top, bottom: top + totalH };
}

/** 非交差前提の折れ線間最小距離 (端点 vs 相手セグメントの総当たり)。 */
function minLeaderGap(leaders: { name: string; points: Pt[] }[]): number {
  let min = Infinity;
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      const pa = leaders[i].points;
      const pb = leaders[j].points;
      const distToPolyline = (p: Pt, pts: Pt[]): number => {
        let d = Number.POSITIVE_INFINITY;
        for (let s = 0; s + 1 < pts.length; s += 1) {
          d = Math.min(
            d,
            distPointToSegment(p.x, p.y, pts[s].x, pts[s].y, pts[s + 1].x, pts[s + 1].y),
          );
        }
        return d;
      };
      for (const p of pa) min = Math.min(min, distToPolyline(p, pb));
      for (const p of pb) min = Math.min(min, distToPolyline(p, pa));
    }
  }
  return min;
}

// ラベル box の円内侵入 (verify_svg の "label inside pie") は全サンプルで 0 であること。
// 回帰元: stress_top_cluster_8 の "F" が draft より大きい |y| へ動き、cascade の nudge を静的
// minTextX が円内へ引き戻していた (24px 侵入)。enforceFinalPieClearance が現在 y で円外へ逃がす。
// 左右ラベル (anchor=end/start) の円中心向き縁はちょうど text x で SVG から正確に取れるため、
// em 幅近似 (textBoxPx) の誤差は縦方向のみに限定され、tol=8px で 24px 級の回帰を確実に捕捉する。
// 円中心 (= viewBox 中心) と半径 (path の "A r,r") を取る堅牢版。1 スライス (全円弧パス、頂点 L なし) や
// 2 スライス等、parsePie が想定する楔パス先頭 "M cx,cy L ... A" に合致しない描画でも壊れない。
function parsePieRobust(svg: string): { cx: number; cy: number; r: number } {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const r = svg.match(/[ML][\d.\-]+,[\d.\-]+ A([\d.]+),/);
  if (!vb || !r) throw new Error('pie geometry not found');
  return { cx: parseFloat(vb[1]) / 2, cy: parseFloat(vb[2]) / 2, r: parseFloat(r[1]) };
}

describe('ラベル box の円内侵入なし (label inside pie / 全サンプル)', () => {
  const allNames = Object.keys(samples);
  it(`全 ${allNames.length} サンプルで text box が pie 円を侵さない`, async () => {
    const offenders: string[] = [];
    for (const name of allNames) {
      const items = resolveInputData({ data: samples[name].items });
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const pie = parsePieRobust(svg);
      for (const t of parseTexts(svg)) {
        if (t.inside) continue; // wedge 内ラベルは対象外 (円内に置くのが正)。
        const b = textBoxPx(t);
        const nx = Math.max(b.left, Math.min(b.right, pie.cx));
        const ny = Math.max(b.top, Math.min(b.bottom, pie.cy));
        // verify_svg.bboxIntrudesPie と同じ tolerance 2px。
        const intrusion = pie.r - Math.hypot(nx - pie.cx, ny - pie.cy);
        if (intrusion > 2) {
          offenders.push(`${name}: "${t.name}" (${intrusion.toFixed(0)}px)`);
        }
      }
    }
    expect(offenders, `円内へ侵入したラベル:\n${offenders.join('\n')}`).toEqual([]);
    // 83 サンプルをフルレンダリングする重い集約テスト。CI のカバレッジ計測 (vitest --coverage)
    // 下では既定 5s を超えるため timeout を広げる (検査ロジック・閾値は不変)。30s では GH Actions
    // ランナーの遅い日 (render_hash がローカル比 ~2.7 倍の実測) に境界超えで flake したため、
    // `render_hash.test.ts` と同じ「併走実測を余裕込みで収める」方針の値にする。
  }, 120_000);
});

describe('leader 幾何の不変条件 (実レンダリング)', () => {
  for (const name of [...REGRESSION_SAMPLES, ...SENTINEL_SAMPLES]) {
    it(`${name}: leader 交差なし・円内貫通なし・曲がり ≤1`, async () => {
      expect(samples[name], `sample "${name}" が samples.json に存在する`).toBeTruthy();
      const items = resolveInputData({ data: samples[name].items });
      // フォント埋め込みは幾何と無関係なので無効化してテストを高速に保つ。
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const leaders = parseLeaders(svg);
      const pie = parsePie(svg);

      expect(leaderCrossings(leaders), 'leader 同士の交差').toEqual([]);
      expect(pieIntrusions(leaders, pie), 'leader の円内貫通').toEqual([]);
      for (const l of leaders) {
        expect(l.points.length - 2, `"${l.name}" の曲がり回数`).toBeLessThanOrEqual(1);
      }
    });
  }
});

// 回帰: その他(帯外 115°)×アイルランド(144°) の左スタック逆転で leader が 1.2px まで接近し
// 視覚交差、かつアイルランドが viewBox 左へ 12px 見切れていた (untangle の その他 無条件除外が原因)。
// 現在は その他 が左拡張帯の真上垂直 center 配置 (anchor=middle) になったため、rim スタックの
// 単調性チェックからは本体 angularStacks と同様に除外する (中央固定配置は y 基準が異なる)。
describe('fidelity_foreign_bond_country: その他を含む左スタックの角度順と見切れ', () => {
  it('leader 間隔 ≥2px・左スタック anchorY 単調・横見切れなし', async () => {
    const name = 'pdf_510037_07_fidelity_foreign_bond_country';
    const items = resolveInputData({ data: samples[name].items });
    const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
    const leaders = parseLeaders(svg);
    const pie = parsePie(svg);
    const texts = parseTexts(svg);
    const viewW = parseFloat(svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)?.[1] ?? '0');

    // 1. leader 同士の最小距離 (修正前 1.22px の視覚接触 → 余白を要求)
    expect(minLeaderGap(leaders), 'leader 間の最小距離(px)').toBeGreaterThanOrEqual(2);

    // 2. 左スタック (その他含む) のラベル縦順 == アンカー縦順
    const anchorOf = new Map(
      leaders.map((l) => {
        const head = l.points[0];
        const tail = l.points[l.points.length - 1];
        const dHead = Math.hypot(head.x - pie.cx, head.y - pie.cy);
        const dTail = Math.hypot(tail.x - pie.cx, tail.y - pie.cy);
        return [l.name, dHead <= dTail ? head : tail];
      }),
    );
    const leftStack = texts
      .filter((t) => !t.inside && t.x < pie.cx && t.anchor !== 'middle' && anchorOf.has(t.name))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < leftStack.length; i += 1) {
      const prev = anchorOf.get(leftStack[i - 1].name)!;
      const cur = anchorOf.get(leftStack[i].name)!;
      expect(
        cur.y,
        `左スタック角度順: "${leftStack[i - 1].name}" の下の "${leftStack[i].name}" はアンカーも下`,
      ).toBeGreaterThanOrEqual(prev.y - 2);
    }

    // 3. 横方向の viewBox 収まり (修正前: アイルランド左 12px 見切れ)。
    //    幅は簡易 em (CJK=1.0 / その他=0.55) × fontSize。% 行に長体は掛からない。
    const lineWidth = (t: TextInfo, line: string): number => {
      const em = [...line].reduce((s, ch) => s + (ch.charCodeAt(0) > 0x2e7f ? 1.0 : 0.55), 0);
      const sx = /%$/.test(line.trim()) ? 1 : t.nameScaleX;
      return em * t.fontSize * sx;
    };
    for (const t of texts) {
      for (const line of t.lines) {
        const w = lineWidth(t, line);
        const left = t.anchor === 'end' ? t.x - w : t.anchor === 'middle' ? t.x - w / 2 : t.x;
        const right = left + w;
        expect(left, `"${t.name}" 行 "${line}" の左端`).toBeGreaterThanOrEqual(-0.5);
        expect(right, `"${t.name}" 行 "${line}" の右端`).toBeLessThanOrEqual(viewW + 0.5);
      }
    }
  });
});

// 左拡張帯 (108°,122°] の上部「その他」はスライス中心軸の真上に center 配置し、垂直 leader
// 1 本で結ぶ (topBandSonohokaZone="leftExt")。修正前は汎用 rim 扱いで左上隅 (右端 x≈118px) へ
// 押し出され、約 108px の水平 leader が伸びていた。
describe('左拡張帯の上部その他: スライス中心軸の真上に垂直 leader で center 配置', () => {
  const EXT_SAMPLES = [
    'pdf_510037_07_fidelity_foreign_bond_country', // その他 mid≈115.2°
    'country_europe_heavy_8', // その他 mid≈117.0°
  ] as const;
  for (const name of EXT_SAMPLES) {
    it(`${name}: その他が anchor=middle・中心軸上・垂直 leader`, async () => {
      const items = resolveInputData({ data: samples[name].items });
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const pie = parsePie(svg);
      const texts = parseTexts(svg);
      const leaders = parseLeaders(svg);

      const sonohoka = texts.find((t) => t.name.startsWith('その他'));
      expect(sonohoka, 'その他ラベルが存在する').toBeTruthy();
      expect(sonohoka!.anchor, 'その他は center 配置').toBe('middle');

      // text x がスライス中心軸 (アンカー x) 付近: 垂直 leader の両端 x とほぼ一致する。
      const leader = leaders.find((l) => l.name.startsWith('その他'));
      expect(leader, 'その他に leader が描かれる').toBeTruthy();
      const xs = leader!.points.map((p) => p.x);
      const drift = Math.max(...xs) - Math.min(...xs);
      expect(drift, 'leader の水平ドリフト(px)').toBeLessThanOrEqual(2);
      expect(leader!.points.length - 2, 'leader の曲がり回数').toBeLessThanOrEqual(0);
      expect(Math.abs(sonohoka!.x - xs[0]), 'text x とアンカー x の乖離(px)').toBeLessThanOrEqual(
        2,
      );
      // 中心より左 (midAngle>90°) かつ左隅 (旧 118px) より大きく右にある。
      expect(sonohoka!.x).toBeLessThan(pie.cx);
      expect(sonohoka!.x).toBeGreaterThan(pie.cx - pie.r);
    });
  }
});

// コア帯 (90°±18°) の上部「その他」を右上へ逃がす際、箱を pie キャップより完全に上へ持ち上げて
// (topRightLiftedRimDraft) pie の横押し出しを無効化し、短い leader で結ぶ。修正前は箱下端が円の
// y 域に入り pie クリアランスが textX を右へ大きく押し出して 100〜184px の水平 leader が
// チャート上部を横断していた。box 下端が pie キャップ (cy - r) より上 (pixel y が小) であること、
// leader の水平ドリフトが短いことを固定する。
describe('コア帯の上部その他: pie キャップ上へ持ち上げ短い leader で右上配置', () => {
  const LIFT_SAMPLES = [
    'pdf_510037_05_global_reit_idx_country', // その他 7.1%
    'pdf_510037_05_global_reit_idx_currency', // その他 3.5%
    'pdf_510037_07_fidelity_foreign_bond_currency', // その他 5.6%
  ] as const;
  for (const name of LIFT_SAMPLES) {
    it(`${name}: その他 box が pie キャップ上・leader 水平ドリフト短い`, async () => {
      const items = resolveInputData({ data: samples[name].items });
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const pie = parsePieRobust(svg);
      const texts = parseTexts(svg);
      const leaders = parseLeaders(svg);

      const sonohoka = texts.find((t) => t.name.startsWith('その他'));
      expect(sonohoka, 'その他ラベルが存在する').toBeTruthy();
      // 右上逃がし (anchor=start・中心より右) のときだけ lift 不変条件を検査する。
      if (sonohoka!.anchor === 'start' && sonohoka!.x > pie.cx) {
        const box = textBoxPx(sonohoka!);
        // box 下端 (pixel y 最大) が pie キャップ (cy - r) より上 (= 小さい y)。クリアランス 2px 許容。
        expect(box.bottom, 'その他 box 下端が pie キャップより上 (pixel y)').toBeLessThanOrEqual(
          pie.cy - pie.r + 2,
        );

        // box が pie キャップ上にあることが本質的不変条件 (上の assert)。leader 水平ドリフトは
        // その帰結なので、チャート上部を横断する旧実装 (最大 ~180px) を捕える緩い上限のみ課す。
        const leader = leaders.find((l) => l.name.startsWith('その他'));
        expect(leader, 'その他に leader が描かれる').toBeTruthy();
        const xs = leader!.points.map((p) => p.x);
        const drift = Math.max(...xs) - Math.min(...xs);
        expect(drift, 'その他 leader の水平ドリフト(px)').toBeLessThan(pie.r);
      }
    });
  }
});

describe('twoLineLeftStackMode: 左多数ラベルを全 2 行で密に縦積み (参考PDF配置)', () => {
  // 左列 (その他除く) に >=6 ラベルが寄る過密チャートで、左列ラベルが全て 2 行を維持し、
  // viewBox 左端を見切れないことを検査する。回帰元: world_bond_idx_country の イギリス が
  // 1 行へ降格して左 19px 見切れ ("ギリス")。applyTwoLineLeftColumn が canvas 全高の密ピッチ列で
  // 全 2 行を収める。短名カタカナ (スペイン/カナダ/イギリス 等) は rim ハグでも見切れない前提。
  const LEFT_COLUMN_NAMES = [
    'スペイン',
    '国際機関',
    'イタリア',
    'カナダ',
    'イギリス',
    'ドイツ',
    'フランス',
  ];
  it('world_bond_idx_country: 左列が全 2 行・左端見切れなし・円と隙間ありリーダー可視', async () => {
    const items = resolveInputData({
      data: samples['pdf_510037_02_world_bond_idx_country'].items,
    });
    const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
    const pie = parsePieRobust(svg);
    const texts = parseTexts(svg);
    const oneLine: string[] = [];
    const clipped: string[] = [];
    const noGap: string[] = [];
    // 左列ラベル右端と円縁の水平隙間がリーダー線として見える最小幅 (≈0.12R)。回帰元: ラベルが
    // 円に密着 (隙間 ~5px) しスタブが読めなかった件。applyTwoLineLeftColumn の rim 外押し出しで確保。
    const minGapPx = pie.r * 0.12;
    for (const name of LEFT_COLUMN_NAMES) {
      const t = texts.find((x) => x.name === name);
      expect(t, `${name} ラベルが存在する`).toBeTruthy();
      if (t!.lineCount < 2) oneLine.push(name);
      const box = textBoxPx(t!);
      // 短名カタカナの左列は 2 行で viewBox 左端 (x=0) を見切れない。1px 許容。
      if (box.left < -1) clipped.push(`${name}@${box.left.toFixed(0)}`);
      // ラベル右端 (anchor=end の box.right) と円縁との水平隙間。box の縦中心 y で円の左縁 x を取る。
      const dy = Math.min(Math.abs((box.top + box.bottom) / 2 - pie.cy), pie.r);
      const circleLeftX = pie.cx - Math.sqrt(pie.r * pie.r - dy * dy);
      if (circleLeftX - box.right < minGapPx) {
        noGap.push(`${name}@gap${(circleLeftX - box.right).toFixed(0)}`);
      }
    }
    expect(oneLine, `1 行へ降格した左列ラベル: ${oneLine.join(',')}`).toEqual([]);
    expect(clipped, `左端を見切れた左列ラベル: ${clipped.join(',')}`).toEqual([]);
    expect(noGap, `円と隙間が不足する左列ラベル (リーダー不可視): ${noGap.join(',')}`).toEqual([]);
  });
});

describe('左列ラベルの縦順序 == スライス角度順 (back-to-back 対の逆転検出)', () => {
  // 回帰元: pdf_510037_02_world_bond_idx_country_20240426 で 9 時線近傍の小スライス対
  // イギリス(下スライス)/イタリア(上スライス) が baseline 逆向きの back-to-back 配置となり、
  // 下スライスの イギリス が上に来る逆転が起きていた。verify / 内部指標が縦位置を生の `t.y` で
  // 測っていたため (back-to-back では両者の `t.y` がほぼ同値) 逆転を見逃していた。本テストは
  // ラベル box の **縦中心** 順とアンカー(引出先 rim 点)y 順の一致を検査し、視覚的逆転を捕捉する。
  it('world_bond_idx_country_20240426: 左列 box 中心順 == アンカー y 順・イタリアがイギリスの上', async () => {
    const items = resolveInputData({
      data: samples['pdf_510037_02_world_bond_idx_country_20240426'].items,
    });
    const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
    const pie = parsePieRobust(svg);
    const leaders = parseLeaders(svg);
    // 各ラベルの引出アンカー = leader 折れ線で円中心に最も近い端点 (verify_svg と同基準)。
    const anchorYOf = (name: string): number | null => {
      const l = leaders.find((x) => x.name === name);
      if (!l) return null;
      let best: { y: number; d: number } | null = null;
      for (const p of l.points) {
        const d = Math.hypot(p.x - pie.cx, p.y - pie.cy);
        if (!best || d < best.d) best = { y: p.y, d };
      }
      return best ? best.y : null;
    };
    // 左側 (box 中心 x < 円中心) の円外ラベルを box 縦中心の昇順 (上→下) に並べる。
    const left = parseTexts(svg)
      .filter((t) => !t.inside)
      .map((t) => {
        const b = textBoxPx(t);
        return {
          name: t.name,
          cx: (b.left + b.right) / 2,
          cy: (b.top + b.bottom) / 2,
          anchorY: anchorYOf(t.name),
        };
      })
      .filter((e) => e.cx < pie.cx && e.anchorY !== null)
      .sort((a, b) => a.cy - b.cy);

    // box 中心で上にあるラベルのアンカーが下のラベルのアンカーより下 (anchorY が大) なら視覚的逆転。
    const inversions: string[] = [];
    for (let i = 1; i < left.length; i += 1) {
      if ((left[i].anchorY as number) < (left[i - 1].anchorY as number) - 2) {
        inversions.push(`"${left[i - 1].name}" が "${left[i].name}" の上 (アンカー逆転)`);
      }
    }
    expect(inversions, `左列の角度順逆転:\n${inversions.join('\n')}`).toEqual([]);

    // 当該対を明示検査: イタリア(上スライス) は イギリス(下スライス) より上 (box 中心が小)。
    const it = left.find((e) => e.name === 'イタリア');
    const uk = left.find((e) => e.name === 'イギリス');
    expect(it, 'イタリア ラベルが左列に存在する').toBeTruthy();
    expect(uk, 'イギリス ラベルが左列に存在する').toBeTruthy();
    expect(
      (it as { cy: number }).cy,
      'イタリアの box 中心が イギリスより上 (cy が小さい)',
    ).toBeLessThan((uk as { cy: number }).cy);
  });
});

// 引出線が **自分自身のラベル** の bbox を貫通しないこと。`verify_svg.ts` の "leader through label"
// は j===i (自ラベル) をスキップするため自貫通を検出できず、中央寄せラベル (アンカー x が box 水平
// 範囲内) で起きる「真下中央 (中国 10.6%) / 真上中央 (ケイマン諸島 1.5%)」の文字食い込みを取りこぼす。
// `leader_geometry.ts` の computeDrawnLeader が接続点を pie 側の上下縁中央へ寄せて防ぐのを固定する。
describe('引出線が自ラベル box を貫通しない (self-penetration)', () => {
  // verify_svg.ts segIntersectsBox と同条件 (両端 box 内=接続点が縁の通常形 → 非貫通)。
  const segIntersectsBox = (
    p1: Pt,
    p2: Pt,
    box: { left: number; right: number; top: number; bottom: number },
  ): boolean => {
    const inA = p1.x >= box.left && p1.x <= box.right && p1.y >= box.top && p1.y <= box.bottom;
    const inB = p2.x >= box.left && p2.x <= box.right && p2.y >= box.top && p2.y <= box.bottom;
    if (inA && inB) return false;
    if (inA || inB) return true;
    const c = [
      { x: box.left, y: box.top },
      { x: box.right, y: box.top },
      { x: box.right, y: box.bottom },
      { x: box.left, y: box.bottom },
    ];
    for (let k = 0; k < 4; k += 1) {
      if (segmentsIntersect(p1, p2, c[k], c[(k + 1) % 4])) return true;
    }
    return false;
  };

  // 回帰元: pdf_510037_01 の ケイマン諸島 1.5% (真上中央) が L 字 leader で box 中央まで伸び文字貫通。
  // world_bond_idx_country_20240426 の 中国 (真下中央) は先行 fix の対象。両者とも自貫通 0 を固定する。
  const SELF_PEN_SAMPLES = [
    'pdf_510037_01_fund_country_20240710',
    'pdf_510037_02_world_bond_idx_country_20240426',
  ] as const;
  for (const name of SELF_PEN_SAMPLES) {
    it(`${name}: どの leader も自分の label box を貫通しない`, async () => {
      expect(samples[name], `sample "${name}" が samples.json に存在する`).toBeTruthy();
      const items = resolveInputData({ data: samples[name].items });
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const leaders = parseLeaders(svg);
      const texts = parseTexts(svg);
      const offenders: string[] = [];
      for (const l of leaders) {
        const t = texts.find((x) => x.name === l.name);
        if (!t || t.inside) continue;
        const box = textBoxPx(t);
        for (let k = 0; k + 1 < l.points.length; k += 1) {
          if (segIntersectsBox(l.points[k], l.points[k + 1], box)) {
            offenders.push(l.name);
            break;
          }
        }
      }
      expect(offenders, `自ラベルを貫通した leader: ${offenders.join(',')}`).toEqual([]);
    });
  }
});
