// =============================================================================
// verify_svg.ts — 生成済み SVG の自動検証 (graph/verify_svg.js の TS 移植)
// -----------------------------------------------------------------------------
// チェック項目:
//   1. ラベル数 == スライス数
//   2. ラベル bbox 同士の重なり (8px 以上 warning)
//   3. 円内侵入 (ラベル bbox / 引出線 segment が pie の内側)
//   3.5 引出線同士の交差
//   3.6 引出線が他ラベルの bbox を貫通
//   4. viewBox はみ出し
//   5. 引出線の曲がり回数 (1 本につき最大 1 回)
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// drift ガード専用の import。検証ロジック(交差・bbox 等)は本体から取り込まず独立を保つが、
// 手動同期に頼っていたメトリクス定数/文字幅分類だけは起動時に本体と突き合わせる(assertOracleSync)。
import { createPieLayoutConfig } from "./src/config.js";
import {
  TOP_BAND_HALF_WIDTH_DEG as bodyTopBandHalfWidthDeg,
  TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG as bodySonohokaLeftExtHalfWidthDeg,
} from "./src/label_placement.js";
import { visualCharEm as bodyVisualCharEm } from "./src/svg_geom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(__dirname, "out");
const jsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(outRoot, "svg_js");

interface BBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface TextInfo {
  x: number;
  y: number;
  fontSize: number;
  anchor: string;
  baseline: string;
  text: string;
  lineCount: number;
  insideSlice: boolean;
  nameScaleX: number; // 名前長体率 (data-name-scale-x)。1 = 原寸。
  tspans: string[]; // 生 tspan テキスト列 (名前長体時の幅再計算に使う)。
  name: string; // data-name (対応スライス名。XML エスケープ済みの生値)。
  percent: number; // data-percent (対応スライスとの突き合わせ用)。
}

interface Point {
  x: number;
  y: number;
}

interface PieGeometry {
  cx: number;
  cy: number;
  r: number;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 描画器(config.ts)の bbox 推定係数と同期すべき定数。verify は独立オラクルとして検証
// *ロジック* は本体から import せず複製するが、ここで複製する *数値* は起動時に
// assertOracleSync() が本体 (config.ts の既定値 / svg_geom.visualCharEm の判定域) と一致するか
// 自動照合し、乖離があれば FAIL する。よって手動同期忘れによる false PASS/FAIL は防がれる
// (定数を変えたら verify を一度走らせれば drift を検知できる)。
// 幅は実描画 em (全角=1.0 / 半角・ASCII=0.5) × fontSizeUnits で数える (= 本体の
// visualTextWidthUnits)。charWidthFactor は安全マージン用ノブで既定 1.0。
const CHAR_WIDTH_FACTOR = 1.0; // = config.charWidthFactor
const LINE_HEIGHT_FACTOR = 1.1; // = config.lineHeightFactor (= lineSpacing)
const VISUAL_FULLWIDTH_EM = 1.0; // = config.visualFullwidthEm
const VISUAL_HALFWIDTH_EM = 0.5; // = config.visualHalfwidthEm
const NAME_CONDENSE_STEPS = [0.7]; // = config.nameCondenseSteps (名前長体の試行段)
const TOP_BAND_HALF_WIDTH_DEG = 18; // = label_placement.TOP_BAND_HALF_WIDTH_DEG (その他逃がし帯)
// = label_placement.TOP_BAND_SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG (その他 真上垂直配置の左拡張帯)
const SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG = 32;

// 文字幅は本体 (svg_geom.visualCharEm) の実 glyph advance テーブルをそのまま使う。verify が
// 独自に幅モデルを複製すると本体と乖離し得るため、幅分類はオラクル(本体)を直接引く。数値定数
// (charWidthFactor 等) のみ複製し assertOracleSync で照合する。
const oracleCfg = createPieLayoutConfig();

function visualLineUnits(text: string): number {
  let sum = 0;
  for (const ch of text) sum += bodyVisualCharEm(ch, oracleCfg);
  return sum;
}

/**
 * verify のローカル複製定数/文字幅分類が本体 (config.ts / svg_geom.visualCharEm) と
 * 一致するかを起動時に照合する drift ガード。一致時は無出力。不一致時はズレを列挙して終了。
 */
function assertOracleSync(): void {
  const cfg = createPieLayoutConfig();
  const mismatches: string[] = [];
  const checkConst = (name: string, body: number, oracle: number) => {
    if (body !== oracle) mismatches.push(`${name}: body=${body} oracle=${oracle}`);
  };
  checkConst("charWidthFactor", cfg.charWidthFactor, CHAR_WIDTH_FACTOR);
  checkConst("lineHeightFactor", cfg.lineHeightFactor, LINE_HEIGHT_FACTOR);
  checkConst("visualFullwidthEm", cfg.visualFullwidthEm, VISUAL_FULLWIDTH_EM);
  checkConst("visualHalfwidthEm", cfg.visualHalfwidthEm, VISUAL_HALFWIDTH_EM);
  checkConst("topBandHalfWidthDeg", bodyTopBandHalfWidthDeg, TOP_BAND_HALF_WIDTH_DEG);
  checkConst(
    "sonohokaLeftExtHalfWidthDeg",
    bodySonohokaLeftExtHalfWidthDeg,
    SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG,
  );
  const steps = cfg.nameCondenseSteps;
  if (
    steps.length !== NAME_CONDENSE_STEPS.length ||
    steps.some((v, i) => v !== NAME_CONDENSE_STEPS[i])
  ) {
    mismatches.push(`nameCondenseSteps: body=[${steps}] oracle=[${NAME_CONDENSE_STEPS}]`);
  }

  // 実 glyph advance テーブル (src/glyph_advance.ts) が確かに読み込まれ本体 visualCharEm に
  // 効いているかを代表コードポイントで検査する。テーブル未生成/未適用なら旧 heuristic の
  // 0.5/1.0 に落ちて以下の実測値と乖離し FAIL する。漢字は既定 1.0、BIZ UDPGothic の
  // プロポーショナルかな ('ア') と全角幅 ASCII ('%') はテーブル収録値。
  const widthProbes: [string, number][] = [
    ["0", 0.7598], ["8", 0.7598], [".", 0.3301], ["%", 1.0], [" ", 0.3335],
    ["株", 1.0], ["ア", 0.9102],
  ];
  for (const [ch, expect] of widthProbes) {
    const body = bodyVisualCharEm(ch, cfg);
    if (Math.abs(body - expect) > 1e-4) {
      mismatches.push(`visualCharEm("${ch}"): body=${body} expected≈${expect} (glyph_advance テーブル未適用?)`);
    }
  }

  if (mismatches.length > 0) {
    console.error("✖ verify_svg のメトリクス定数/文字幅が本体と乖離しています:");
    for (const m of mismatches) console.error(`    - ${m}`);
    console.error(
      "  → 定数は verify_svg.ts を config.ts に合わせ、幅は `npm run gen:widths` で" +
        " src/glyph_advance.ts を再生成してください。",
    );
    process.exit(1);
  }
}

function textBBox(t: TextInfo): BBox {
  const charWidth = t.fontSize * CHAR_WIDTH_FACTOR;
  const lineH = t.fontSize * LINE_HEIGHT_FACTOR;
  const totalH = lineH * t.lineCount;
  const sx = t.nameScaleX;
  let totalW: number;
  if (sx >= 1) {
    const lines = t.lineCount >= 2 ? t.tspans : [t.tspans.join("")];
    const maxUnits = Math.max(...lines.map((s) => visualLineUnits(s)));
    totalW = maxUnits * charWidth;
  } else {
    // 名前長体: 名前(tspan[0])は ×sx、% 部分(残り tspan)は原寸。
    const name = t.tspans[0] ?? "";
    const rest = t.tspans.slice(1).join("");
    totalW =
      t.lineCount >= 2
        ? Math.max(visualLineUnits(name) * sx, visualLineUnits(rest)) * charWidth
        : (visualLineUnits(name) * sx + visualLineUnits(rest)) * charWidth;
  }

  let left: number;
  if (t.anchor === "start") left = t.x;
  else if (t.anchor === "end") left = t.x - totalW;
  else left = t.x - totalW / 2;

  let top: number;
  if (t.baseline === "text-after-edge") {
    top = t.y - totalH;
  } else {
    top = t.y;
  }

  return { left, top, right: left + totalW, bottom: top + totalH };
}

function verticalOverlapDepth(a: BBox, b: BBox): number {
  const overlapTop = Math.max(a.top, b.top);
  const overlapBottom = Math.min(a.bottom, b.bottom);
  return overlapBottom - overlapTop;
}

function overlaps(a: BBox, b: BBox, tol = 2): boolean {
  return (
    a.left < b.right - tol &&
    a.right > b.left + tol &&
    a.top < b.bottom - tol &&
    a.bottom > b.top + tol
  );
}

function parseJsSlices(content: string): number {
  let count = 0;
  for (const m of content.matchAll(/<path[^>]+>/g)) {
    const tag = m[0];
    const fill = tag.match(/\bfill="([^"]+)"/)?.[1] ?? "";
    if (fill && fill !== "#ffffff" && fill !== "none") count++;
  }
  return count;
}

/** スライスグループ (<g class="slice" data-name data-percent>) を描画(=DOM 出現)順に拾う。 */
function parseJsSliceOrder(content: string): { name: string; percent: number }[] {
  const out: { name: string; percent: number }[] = [];
  const re = /<g class="slice"([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1];
    const name = attrs.match(/\bdata-name="([^"]*)"/)?.[1] ?? "";
    const percent = parseFloat(attrs.match(/\bdata-percent="([^"]+)"/)?.[1] ?? "NaN");
    out.push({ name, percent });
  }
  return out;
}

function parsePieGeometry(content: string): PieGeometry | null {
  const m = content.match(/<path d="M([\d.\-]+),([\d.\-]+) L[\d.\-]+,[\d.\-]+ A([\d.\-]+),/);
  if (!m) return null;
  return { cx: parseFloat(m[1]), cy: parseFloat(m[2]), r: parseFloat(m[3]) };
}

function parseJsLabels(content: string): { texts: TextInfo[]; leaders: (Point[] | null)[] } {
  const texts: TextInfo[] = [];
  const leaders: (Point[] | null)[] = [];
  const groupRe = /<g class="label"([^>]*)>([\s\S]*?)<\/g>/g;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(content)) !== null) {
    const groupAttrs = gm[1];
    const inner = gm[2];
    const insideSlice = /\bdata-inside-slice="true"/.test(groupAttrs);
    const name = groupAttrs.match(/\bdata-name="([^"]*)"/)?.[1] ?? "";
    const percent = parseFloat(groupAttrs.match(/\bdata-percent="([^"]+)"/)?.[1] ?? "NaN");
    const sxRaw = parseFloat(groupAttrs.match(/data-name-scale-x="([^"]+)"/)?.[1] ?? "1");
    const nameScaleX = Number.isFinite(sxRaw) ? sxRaw : 1;
    const lineCountAttr = groupAttrs.match(/data-line-count="([^"]+)"/)?.[1];
    const textM = inner.match(/<text([^>]+)>([\s\S]*?)<\/text>/);
    if (!textM) continue;
    const attrs = textM[1];
    const textInner = textM[2];
    const x = parseFloat(attrs.match(/\bx="([^"]+)"/)?.[1] ?? "NaN");
    const y = parseFloat(attrs.match(/\by="([^"]+)"/)?.[1] ?? "NaN");
    const fontSize = parseFloat(attrs.match(/font-size="([^"]+)"/)?.[1] ?? "NaN");
    const anchor = attrs.match(/text-anchor="([^"]+)"/)?.[1] ?? "start";
    const baseline = attrs.match(/dominant-baseline="([^"]+)"/)?.[1] ?? "";
    const tspanTexts = [...textInner.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((t) => t[1]);
    const lineCount = lineCountAttr ? parseInt(lineCountAttr, 10) : tspanTexts.length || 1;
    // 表示・メッセージ用テキスト: 2 行は " / " 連結、1 行はそのまま連結。
    const text = lineCount >= 2 ? tspanTexts.join(" / ") : tspanTexts.join("");
    if (Number.isNaN(x) || Number.isNaN(y) || !text.trim()) continue;
    texts.push({
      x,
      y,
      fontSize,
      anchor,
      baseline,
      text,
      lineCount,
      insideSlice,
      nameScaleX,
      tspans: tspanTexts,
      name,
      percent,
    });

    const leaderM = inner.match(/<path d="([^"]+)" fill="none"[^>]*>/);
    if (!leaderM) {
      leaders.push(null);
      continue;
    }
    const points: Point[] = [];
    for (const cmd of leaderM[1].matchAll(/[ML]([\d.\-]+),([\d.\-]+)/g)) {
      points.push({ x: parseFloat(cmd[1]), y: parseFloat(cmd[2]) });
    }
    leaders.push(points.length >= 2 ? points : null);
  }
  return { texts, leaders };
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentIntrudesPie(a: Point, b: Point, pie: PieGeometry, tolerance = 2): boolean {
  const dist = distancePointToSegment({ x: pie.cx, y: pie.cy }, a, b);
  return dist < pie.r - tolerance;
}

function bboxIntrudesPie(bbox: BBox, pie: PieGeometry, tolerance = 2): boolean {
  const closestX = Math.max(bbox.left, Math.min(pie.cx, bbox.right));
  const closestY = Math.max(bbox.top, Math.min(pie.cy, bbox.bottom));
  const dist = Math.hypot(closestX - pie.cx, closestY - pie.cy);
  return dist < pie.r - tolerance;
}

function parseViewBox(content: string): ViewBox | null {
  const m = content.match(/viewBox="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function bboxOutOfViewBox(
  bbox: BBox,
  vb: ViewBox,
  tolerance = 1,
): { depth: number; sides: string } | null {
  const left = vb.x - bbox.left;
  const top = vb.y - bbox.top;
  const right = bbox.right - (vb.x + vb.width);
  const bottom = bbox.bottom - (vb.y + vb.height);
  const maxOut = Math.max(left, top, right, bottom);
  if (maxOut <= tolerance) return null;
  const sides: string[] = [];
  if (left > tolerance) sides.push(`left ${Math.round(left)}px`);
  if (top > tolerance) sides.push(`top ${Math.round(top)}px`);
  if (right > tolerance) sides.push(`right ${Math.round(right)}px`);
  if (bottom > tolerance) sides.push(`bottom ${Math.round(bottom)}px`);
  return { depth: Math.round(maxOut), sides: sides.join(", ") };
}

function pointOutOfViewBox(p: Point, vb: ViewBox, tolerance = 1): number {
  const left = vb.x - p.x;
  const top = vb.y - p.y;
  const right = p.x - (vb.x + vb.width);
  const bottom = p.y - (vb.y + vb.height);
  const maxOut = Math.max(left, top, right, bottom);
  return maxOut > tolerance ? Math.round(maxOut) : 0;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point, tolerance = 0.5): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
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

function findLeaderCrossing(
  pointsA: Point[],
  pointsB: Point[],
): { ax: [Point, Point]; bx: [Point, Point] } | null {
  for (let i = 0; i + 1 < pointsA.length; i += 1) {
    const a1 = pointsA[i];
    const a2 = pointsA[i + 1];
    for (let j = 0; j + 1 < pointsB.length; j += 1) {
      const b1 = pointsB[j];
      const b2 = pointsB[j + 1];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return { ax: [a1, a2], bx: [b1, b2] };
      }
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

assertOracleSync();

const jsSamples = new Set(
  fs.readdirSync(jsDir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)),
);

const allNames = [...jsSamples].sort();

interface IssueEntry {
  name: string;
  issue: string;
}

interface OverlapIssue {
  tag: "overlap" | "tight";
  depth: number;
  msg: string;
}

const issues: IssueEntry[] = [];
const stats = { ok: 0, warn: 0, error: 0 };

console.log(`\n${"─".repeat(72)}`);
console.log(`  SVG rendering verification  (${allNames.length} samples)`);
console.log(`${"─".repeat(72)}`);

for (const name of allNames) {
  const rowIssues: (string | OverlapIssue)[] = [];

  const jsSvg = fs.readFileSync(path.join(jsDir, `${name}.svg`), "utf-8");
  const { texts: jsTexts, leaders: leaderPaths } = parseJsLabels(jsSvg);
  const jsSlices = parseJsSlices(jsSvg);
  const jsSliceOrder = parseJsSliceOrder(jsSvg);
  const pie = parsePieGeometry(jsSvg);
  const viewBox = parseViewBox(jsSvg);

  if (jsSlices > 0 && jsTexts.length !== jsSlices) {
    rowIssues.push(`label count mismatch: labels=${jsTexts.length} slices=${jsSlices}`);
  }

  const OVERLAP_WARN_PX = 8;
  if (jsTexts.length > 1) {
    const bboxes = jsTexts.map(textBBox);
    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        if (overlaps(bboxes[i], bboxes[j])) {
          const depth = Math.round(verticalOverlapDepth(bboxes[i], bboxes[j]));
          const ti = jsTexts[i].text;
          const tj = jsTexts[j].text;
          const tag: "overlap" | "tight" = depth >= OVERLAP_WARN_PX ? "overlap" : "tight";
          rowIssues.push({ tag, depth, msg: `${tag}(${depth}px): "${ti}" ↔ "${tj}"` });
        }
      }
    }
  }

  if (pie) {
    for (let i = 0; i < jsTexts.length; i++) {
      if (jsTexts[i].insideSlice) continue;
      const bbox = textBBox(jsTexts[i]);
      if (bboxIntrudesPie(bbox, pie)) {
        const depth = Math.round(
          pie.r -
            Math.hypot(
              Math.max(bbox.left, Math.min(pie.cx, bbox.right)) - pie.cx,
              Math.max(bbox.top, Math.min(pie.cy, bbox.bottom)) - pie.cy,
            ),
        );
        rowIssues.push(`label inside pie (${depth}px): "${jsTexts[i].text}"`);
      }
    }
    for (const points of leaderPaths) {
      if (!points) continue;
      for (let i = 0; i + 1 < points.length; i++) {
        if (segmentIntrudesPie(points[i], points[i + 1], pie)) {
          const dist = distancePointToSegment(
            { x: pie.cx, y: pie.cy },
            points[i],
            points[i + 1],
          );
          const depth = Math.round(pie.r - dist);
          rowIssues.push(
            `leader inside pie (${depth}px): segment (${Math.round(points[i].x)},${Math.round(points[i].y)})→(${Math.round(points[i + 1].x)},${Math.round(points[i + 1].y)})`,
          );
          break;
        }
      }
    }
  }

  for (let i = 0; i < leaderPaths.length; i++) {
    if (!leaderPaths[i]) continue;
    for (let j = i + 1; j < leaderPaths.length; j++) {
      if (!leaderPaths[j]) continue;
      const cross = findLeaderCrossing(leaderPaths[i]!, leaderPaths[j]!);
      if (cross) {
        const ti = jsTexts[i]?.text ?? `path #${i}`;
        const tj = jsTexts[j]?.text ?? `path #${j}`;
        const seg = (s: [Point, Point]) =>
          `(${Math.round(s[0].x)},${Math.round(s[0].y)})→(${Math.round(s[1].x)},${Math.round(s[1].y)})`;
        rowIssues.push(`leader crossing: "${ti}" ${seg(cross.ax)} ↔ "${tj}" ${seg(cross.bx)}`);
      }
    }
  }

  if (jsTexts.length > 0 && leaderPaths.length > 0) {
    const segIntersectsBox = (p1: Point, p2: Point, box: BBox, pad = 2) => {
      const left = box.left + pad;
      const right = box.right - pad;
      const top = box.top + pad;
      const bottom = box.bottom - pad;
      const inA = p1.x >= left && p1.x <= right && p1.y >= top && p1.y <= bottom;
      const inB = p2.x >= left && p2.x <= right && p2.y >= top && p2.y <= bottom;
      if (inA && inB) return false;
      if (inA || inB) return true;
      const corners = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
      for (let k = 0; k < 4; k += 1) {
        const c = corners[k];
        const d = corners[(k + 1) % 4];
        if (segmentsIntersect(p1, p2, c, d)) return true;
      }
      return false;
    };
    for (let i = 0; i < leaderPaths.length; i += 1) {
      const points = leaderPaths[i];
      if (!points) continue;
      for (let j = 0; j < jsTexts.length; j += 1) {
        if (j === i) continue;
        const box = textBBox(jsTexts[j]);
        for (let k = 0; k + 1 < points.length; k += 1) {
          if (segIntersectsBox(points[k], points[k + 1], box)) {
            const owner = jsTexts[i]?.text ?? `path #${i}`;
            const target = jsTexts[j].text;
            const a = points[k];
            const b = points[k + 1];
            rowIssues.push(
              `leader through label: "${owner}" segment (${Math.round(a.x)},${Math.round(a.y)})→(${Math.round(b.x)},${Math.round(b.y)}) crosses bbox of "${target}"`,
            );
            break;
          }
        }
      }
    }
  }

  for (let i = 0; i < leaderPaths.length; i++) {
    const points = leaderPaths[i];
    if (!points) continue;
    const bends = Math.max(0, points.length - 2);
    if (bends > 1) {
      const ti = jsTexts[i]?.text ?? `path #${i}`;
      const seg = points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join("→");
      rowIssues.push(`leader has ${bends} bends (>1): "${ti}" ${seg}`);
    }
  }

  if (viewBox) {
    for (const t of jsTexts) {
      const bbox = textBBox(t);
      const out = bboxOutOfViewBox(bbox, viewBox);
      if (out) {
        rowIssues.push(`label out of viewBox (${out.sides}): "${t.text}"`);
      }
    }
    for (const points of leaderPaths) {
      if (!points) continue;
      let maxOut = 0;
      let worstPoint: Point | null = null;
      for (const p of points) {
        const out = pointOutOfViewBox(p, viewBox);
        if (out > maxOut) {
          maxOut = out;
          worstPoint = p;
        }
      }
      if (maxOut > 0 && worstPoint) {
        rowIssues.push(
          `leader out of viewBox (${maxOut}px): point (${Math.round(worstPoint.x)},${Math.round(worstPoint.y)})`,
        );
      }
    }
  }

  // ── 順序保証チェックA: ラベル ↔ スライス対応 ─────────────────────────────
  // 各ラベルの data-name/data-percent が対応スライスと 1:1 一致するか
  // (取り違え・欠落・余剰・対応ズレの検出)。<g class="slice"> を持つ複数スライス図のみ。
  if (jsSliceOrder.length > 0) {
    const countBy = (names: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
      return m;
    };
    const labelCounts = countBy(jsTexts.map((t) => t.name));
    const sliceCounts = countBy(jsSliceOrder.map((s) => s.name));
    for (const [n, c] of sliceCounts) {
      const lc = labelCounts.get(n) ?? 0;
      if (lc !== c) {
        rowIssues.push(`label/slice mismatch: name "${n}" slice×${c} label×${lc}`);
      }
    }
    for (const [n, c] of labelCounts) {
      if (!sliceCounts.has(n)) {
        rowIssues.push(`label/slice mismatch: label "${n}"×${c} has no matching slice`);
      }
    }
    // percent 突き合わせ (名前がスライス側で一意のもののみ)。
    const slicePctByName = new Map<string, number>();
    for (const s of jsSliceOrder) {
      slicePctByName.set(s.name, (sliceCounts.get(s.name) ?? 0) > 1 ? NaN : s.percent);
    }
    for (const t of jsTexts) {
      const sp = slicePctByName.get(t.name);
      if (
        sp !== undefined &&
        Number.isFinite(sp) &&
        Number.isFinite(t.percent) &&
        Math.abs(sp - t.percent) > 0.05
      ) {
        rowIssues.push(`label/slice percent mismatch: "${t.name}" label=${t.percent} slice=${sp}`);
      }
    }
  }

  // ── 順序保証チェックB: 縦並び == 角度順 (スタック順序の反転検出) ───────────
  // 円外ラベルを左右に分け、ラベル y の昇順でアンカー(引出先 rim 点)の y が
  // 単調非減少かを検査。上にあるラベルのアンカーが下のラベルのアンカーより下なら反転。
  if (pie) {
    interface StackEntry {
      labelY: number;
      anchorY: number;
      text: string;
    }
    const leftStack: StackEntry[] = [];
    const rightStack: StackEntry[] = [];
    for (let i = 0; i < jsTexts.length; i += 1) {
      const t = jsTexts[i];
      if (t.insideSlice) continue;
      const pts = leaderPaths[i];
      if (!pts || pts.length < 2) continue;
      // アンカー = 中心に近い側の端点 (円周 rim ≈ r。ラベル側は r より外)。
      const head = pts[0];
      const tail = pts[pts.length - 1];
      const dHead = Math.hypot(head.x - pie.cx, head.y - pie.cy);
      const dTail = Math.hypot(tail.x - pie.cx, tail.y - pie.cy);
      const anchor = dHead <= dTail ? head : tail;
      // "その他" は意図的に角度順を破る/固定する配置のときのみ除外する: アンカー角が
      // コア帯 (90°±18°, 右上/左上へ逃がす仕様) か左拡張帯 ((108°,122°], 真上垂直 center 固定)、
      // またはラベルとアンカーが中心の左右反対側 (L 字逃がし)。真上垂直配置は視覚的には常に
      // concordant だが、center 配置 (baseline=bottom) と rim 配置 (baseline=top) の生 y 属性は
      // 基準辺が異なり比較できないため、本体 angularStacks と同様に除外する。
      // 帯外 (>122°) で通常 rim 配置された その他 は逆転判定に参加させる (同基準)。
      if (t.name.startsWith("その他")) {
        const angDeg = (Math.atan2(pie.cy - anchor.y, anchor.x - pie.cx) * 180) / Math.PI;
        const norm = ((angDeg % 360) + 360) % 360;
        const inTopBand = Math.abs(norm - 90) <= TOP_BAND_HALF_WIDTH_DEG;
        const inLeftExt =
          norm > 90 + TOP_BAND_HALF_WIDTH_DEG && norm <= 90 + SONOHOKA_LEFT_EXT_HALF_WIDTH_DEG;
        const oppositeSide = (t.x < pie.cx) !== (anchor.x < pie.cx);
        if (inTopBand || inLeftExt || oppositeSide) continue;
      }
      const entry: StackEntry = { labelY: t.y, anchorY: anchor.y, text: t.text };
      (t.x < pie.cx ? leftStack : rightStack).push(entry);
    }
    const ANCHOR_INV_TOL = 2; // px。微小逆転は誤検出回避で無視。
    for (const [sideName, arr] of [
      ["left", leftStack],
      ["right", rightStack],
    ] as const) {
      arr.sort((a, b) => a.labelY - b.labelY);
      for (let i = 1; i < arr.length; i += 1) {
        const prev = arr[i - 1];
        const cur = arr[i];
        if (cur.anchorY < prev.anchorY - ANCHOR_INV_TOL) {
          rowIssues.push(
            `label order inversion(${sideName}): "${prev.text}"(anchorY=${Math.round(prev.anchorY)}) above "${cur.text}"(anchorY=${Math.round(cur.anchorY)})`,
          );
        }
      }
    }
  }

  const strIssues = rowIssues.filter((i): i is string => typeof i === "string");
  const overlapIssues = rowIssues.filter(
    (i): i is OverlapIssue => typeof i === "object" && i.tag === "overlap",
  );
  const tightIssues = rowIssues.filter(
    (i): i is OverlapIssue => typeof i === "object" && i.tag === "tight",
  );

  const hasRealIssue = strIssues.length > 0 || overlapIssues.length > 0;
  const hasTightOnly = !hasRealIssue && tightIssues.length > 0;

  const jsLabel = `js:${jsTexts.length}L/${jsSlices}S`;

  if (hasRealIssue) {
    stats.warn++;
    console.log(`  [WARN] ${name}`);
    for (const issue of strIssues) {
      console.log(`         ⚠  ${issue}`);
      issues.push({ name, issue });
    }
    for (const issue of overlapIssues) {
      console.log(`         ⚠  ${issue.msg}`);
      issues.push({ name, issue: issue.msg });
    }
  } else if (hasTightOnly) {
    stats.ok++;
    const depths = tightIssues.map((i) => i.depth).join(",");
    console.log(`  [OK]   ${name.padEnd(45)} ${jsLabel}  (tight:${depths}px)`);
  } else {
    stats.ok++;
    console.log(`  [OK]   ${name.padEnd(45)} ${jsLabel}`);
  }
}

console.log(`\n${"─".repeat(72)}`);
console.log(`  Result: ${stats.ok} OK (tight-pack accepted), ${stats.warn} warnings`);
if (issues.length > 0) {
  console.log(`\n  Issues summary (${issues.length} total):`);
  for (const { name, issue } of issues) {
    console.log(`    ${name}: ${issue}`);
  }
} else {
  console.log(`  All samples passed.`);
}
console.log(`${"─".repeat(72)}\n`);
