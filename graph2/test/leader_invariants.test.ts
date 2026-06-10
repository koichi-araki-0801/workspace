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
] as const;
const SENTINEL_SAMPLES = ["stress_one_dominant_9", "ten_elements_balanced", "twelve_evenish"] as const;

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
