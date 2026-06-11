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

import { describe, expect, it } from "vitest";
import { resolveInputData, samples } from "../src/data.js";
import { renderPdfStylePieToSvg } from "../src/svg_export/index.js";

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
    const name = gm[1].match(/\bdata-name="([^"]*)"/)?.[1] ?? "";
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
  if (!m) throw new Error("pie geometry not found");
  return { cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(m[3]) };
}

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

function distPointToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
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
      if (distPointToSegment(pie.cx, pie.cy, l.points[k], l.points[k + 1]) < pie.r - tolerancePx) {
        found.push(l.name);
        break;
      }
    }
  }
  return found;
}

// 過去に leader 交差 / 円内貫通を出していた回帰サンプル + 健全な番兵サンプル。
const REGRESSION_SAMPLES = [
  "stress_top_cluster_8",
  "currency_usd_heavy_9",
  "page16_country_allocation",
  "currency_gbca_pdf",
  "currency_many_small_10",
  "pdf_510037_07_fidelity_foreign_bond_country",
] as const;
const SENTINEL_SAMPLES = ["stress_one_dominant_9", "ten_elements_balanced", "twelve_evenish"] as const;

interface TextInfo {
  name: string;
  x: number;
  y: number;
  anchor: string;
  fontSize: number;
  nameScaleX: number;
  lines: string[];
  inside: boolean;
}

/** <g class="label"> 内の <text>/<tspan> を抽出 (leader 有無は問わない)。 */
function parseTexts(svg: string): TextInfo[] {
  const out: TextInfo[] = [];
  const groupRe = /<g class="label"([^>]*)>([\s\S]*?)<\/g>/g;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(svg)) !== null) {
    const name = gm[1].match(/\bdata-name="([^"]*)"/)?.[1] ?? "";
    const nameScaleX = parseFloat(gm[1].match(/\bdata-name-scale-x="([^"]*)"/)?.[1] ?? "1");
    const textM = gm[2].match(/<text x="([\d.\-]+)" y="([\d.\-]+)" text-anchor="(\w+)"[^>]*font-size="([\d.]+)"/);
    if (!textM) continue;
    const lines = [...gm[2].matchAll(/<tspan[^>]*>([^<]+)<\/tspan>/g)].map((m) => m[1]);
    out.push({
      name,
      x: parseFloat(textM[1]),
      y: parseFloat(textM[2]),
      anchor: textM[3],
      fontSize: parseFloat(textM[4]),
      nameScaleX,
      lines,
      inside: !gm[2].includes('fill="none"'),
    });
  }
  return out;
}

/** 非交差前提の折れ線間最小距離 (端点 vs 相手セグメントの総当たり)。 */
function minLeaderGap(leaders: { name: string; points: Pt[] }[]): number {
  let min = Infinity;
  for (let i = 0; i < leaders.length; i += 1) {
    for (let j = i + 1; j < leaders.length; j += 1) {
      const pa = leaders[i].points;
      const pb = leaders[j].points;
      for (const p of pa) {
        for (let m = 0; m + 1 < pb.length; m += 1) {
          min = Math.min(min, distPointToSegment(p.x, p.y, pb[m], pb[m + 1]));
        }
      }
      for (const p of pb) {
        for (let k = 0; k + 1 < pa.length; k += 1) {
          min = Math.min(min, distPointToSegment(p.x, p.y, pa[k], pa[k + 1]));
        }
      }
    }
  }
  return min;
}

describe("leader 幾何の不変条件 (実レンダリング)", () => {
  for (const name of [...REGRESSION_SAMPLES, ...SENTINEL_SAMPLES]) {
    it(`${name}: leader 交差なし・円内貫通なし・曲がり ≤1`, async () => {
      expect(samples[name], `sample "${name}" が samples.json に存在する`).toBeTruthy();
      const items = resolveInputData({ data: samples[name].items });
      // フォント埋め込みは幾何と無関係なので無効化してテストを高速に保つ。
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const leaders = parseLeaders(svg);
      const pie = parsePie(svg);

      expect(leaderCrossings(leaders), "leader 同士の交差").toEqual([]);
      expect(pieIntrusions(leaders, pie), "leader の円内貫通").toEqual([]);
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
describe("fidelity_foreign_bond_country: その他を含む左スタックの角度順と見切れ", () => {
  it("leader 間隔 ≥2px・左スタック anchorY 単調・横見切れなし", async () => {
    const name = "pdf_510037_07_fidelity_foreign_bond_country";
    const items = resolveInputData({ data: samples[name].items });
    const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
    const leaders = parseLeaders(svg);
    const pie = parsePie(svg);
    const texts = parseTexts(svg);
    const viewW = parseFloat(svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)?.[1] ?? "0");

    // 1. leader 同士の最小距離 (修正前 1.22px の視覚接触 → 余白を要求)
    expect(minLeaderGap(leaders), "leader 間の最小距離(px)").toBeGreaterThanOrEqual(2);

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
      .filter((t) => !t.inside && t.x < pie.cx && t.anchor !== "middle" && anchorOf.has(t.name))
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
        const left = t.anchor === "end" ? t.x - w : t.anchor === "middle" ? t.x - w / 2 : t.x;
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
describe("左拡張帯の上部その他: スライス中心軸の真上に垂直 leader で center 配置", () => {
  const EXT_SAMPLES = [
    "pdf_510037_07_fidelity_foreign_bond_country", // その他 mid≈115.2°
    "country_europe_heavy_8", // その他 mid≈117.0°
  ] as const;
  for (const name of EXT_SAMPLES) {
    it(`${name}: その他が anchor=middle・中心軸上・垂直 leader`, async () => {
      const items = resolveInputData({ data: samples[name].items });
      const { svg } = await renderPdfStylePieToSvg(items, { embedFont: false });
      const pie = parsePie(svg);
      const texts = parseTexts(svg);
      const leaders = parseLeaders(svg);

      const sonohoka = texts.find((t) => t.name.startsWith("その他"));
      expect(sonohoka, "その他ラベルが存在する").toBeTruthy();
      expect(sonohoka!.anchor, "その他は center 配置").toBe("middle");

      // text x がスライス中心軸 (アンカー x) 付近: 垂直 leader の両端 x とほぼ一致する。
      const leader = leaders.find((l) => l.name.startsWith("その他"));
      expect(leader, "その他に leader が描かれる").toBeTruthy();
      const xs = leader!.points.map((p) => p.x);
      const drift = Math.max(...xs) - Math.min(...xs);
      expect(drift, "leader の水平ドリフト(px)").toBeLessThanOrEqual(2);
      expect(leader!.points.length - 2, "leader の曲がり回数").toBeLessThanOrEqual(0);
      expect(
        Math.abs(sonohoka!.x - xs[0]),
        "text x とアンカー x の乖離(px)",
      ).toBeLessThanOrEqual(2);
      // 中心より左 (midAngle>90°) かつ左隅 (旧 118px) より大きく右にある。
      expect(sonohoka!.x).toBeLessThan(pie.cx);
      expect(sonohoka!.x).toBeGreaterThan(pie.cx - pie.r);
    });
  }
});
