// =============================================================================
// svg_export/leader_geometry.ts — leader 折れ線の幾何プリミティブ
// -----------------------------------------------------------------------------
// placement から「実際に描画される leader パス」を計算する純幾何層 (`index.ts` から
// 切り出し)。cascade / repair / scoring など上位の配置ロジックはこれらを一方向に呼ぶだけで、
// 本モジュールは `svg_geom` / 型のみに依存する (上位への逆依存なし = 循環なし)。
// =============================================================================

import {
  placementBox,
  labelHeightUnits,
  leaderAttachTargetY,
  clampBendOutsideBox,
  truncateLeaderEndpointAtBox,
  radialFraction,
  segmentsIntersect,
  leaderCrossesBox,
  angleInBand,
  normalizeAngle,
  isOtherCategory,
} from "../svg_geom.js";
import { topBandSonohokaZone } from "../label_placement.js";
import type { BBox } from "../svg_geom.js";
import type { Placement, PieLayoutConfig } from "../types.js";

// 円外ラベルには常時 leader を描く方針フラグ (ユーザー要望: なるべく leader を使う)。
// ON のとき: inside(スライス内)ラベルのみ leaderless、円外ラベルは rim 配置でも leader を描き、
// 円貫通 / hairpin / 冗長な短 leader / leader 同士の交差 による省略を全てバイパスする。
// false に戻すと従来の「leader=最終手段 + 各種省略」挙動。
export const ALWAYS_DRAW_OUTSIDE_LEADERS = true;

// leader の折れ角が鋭く (なす角 > 135°、cos < -0.7) ヘアピン状になり視認性を損なう時に
// その leader を省く cos 閾値。
const UPPER_LEFT_HAIRPIN_VISIBILITY_COS_THRESHOLD = -0.7;
// 上左の小スライスが引く短い leader を省く角度範囲の半幅 (90°中心)。midAngle>90 と併用し
// 12時〜10時半 ([90°,135°]) の小スライスを対象にする (シンガポール 3.5% ≈121.9° を含む)。
const UPPER_LEFT_SMALL_LEADER_HALF_WIDTH_DEG = 45;
// 「冗長な短い leader」を省く対象を 1 強スライスに限る下限 (%)。`label_placement.ts` の
// `DOMINANT_OUTSIDE_EDGE_MIN_PCT` (rim 外縁配置の dominant 判定) と同値。バランス型チャートの中サイズ
// スライス (>smallSliceThreshold だが非 dominant) の rim leader は「なるべく leader を使う」方針どおり残す。
const REDUNDANT_RIM_LEADER_DOMINANT_MIN_PCT = 50;

// leader の anchor→endpoint 角度差の上限 (rad)。これを超えると 1 曲げ bend が極端に遠くなり
// (rc/cos(Δ/2) 発散) 円を回り込めないため、bend 挿入/再配置の対象から外す境界。
export const LEADER_MAX_ANGULAR_DIFF_RAD = (150 * Math.PI) / 180;

// 側辺 rim ラベルの leader 接続を「側辺中央 → box 上辺・水平中央」へ切替える自動判定の余裕係数。
// アンカー Y が box 上辺より (box 高 × この係数) だけ更に上にあるとき発火する (`shouldAttachTopCenter`)。
// アンカーが box 上辺を「かすめる」程度 (gap≈0) の grazing は side-center のままにし、box 高の 1/5 以上
// 明確に上にある真の「降りてくる」leader だけを top-center 化する。実測比較で確定:
// fidelity「イギリス・ポンド」gap/boxH=0.33 (top-center 維持) と REIT「イギリスポンド」0.003
// (側辺中央へ戻す) を分離。値を上げるほど side-center 寄り (保守的)、0.33 を割ると fidelity も落ちる。
const TOP_CENTER_ANCHOR_MARGIN = 0.2;

// アンカー X が box の近縁 (pie 側の縦縁) を越えて pie 側へずれてよい上限 (logical, pieRadius=1 基準)。
// これを超える = アンカーが box の真上でなく横に大きくずれており、top-center だと長い斜め leader に
// なるため side-center を維持する。実測 (emit): fidelity「イギリス・ポンド」overhang=0.16 (真上寄り=
// top-center 維持) / stress「スペイン」0.50・REIT「イギリスポンド」0.27 (横ずれ=側辺中央へ)。
const TOP_CENTER_OVERHANG_MAX = 0.2;

export type Pt = { x: number; y: number };

/**
 * 側辺 rim ラベル (anchor=start/end) のうち、slice アンカー (rim 接点) が **box 上辺より上** にあり
 * leader がパイから「降りてくる」幾何のとき、接続を側辺中央 (右/左中央のふち) でなく box 上辺・水平
 * 中央へ寄せるべきか。アンカーが box 縦範囲の外 (上) = ラベルが自スライスより下へ押し下げられた密集
 * 配置 (例 イギリス・ポンド: 上左の縦スタックに押され box がアンカーより下) を狙い撃つ。アンカーが
 * box の縦範囲内に収まる通常の側辺ラベルは側辺中央接続のまま (非発火)。
 * `computeDrawnLeader` の末尾 else (側辺中央接続) に落ちる左右 rim ラベルだけが対象
 * (inside/forceTopRight/lowerLeft/declipBottom/middle-center は先行分岐で捕捉済み)。純幾何・slice 名
 * 非依存。**最終描画 (`allowTopCenter`=true) でのみ評価**され、scorer/metric/layout の leader 計算には
 * 載らないため、ラベル位置・採点・各 do-no-harm 判定は baseline と完全一致 (位置は不変)。
 */
function shouldAttachTopCenter(p: Placement, box: BBox): boolean {
  if (p.insideSlice) return false;
  if (p.anchor === "middle") return false; // 真上/真下の中央寄せは対象外
  // 縦: アンカーが box 上辺より明確に上 (leader がパイから降りてくる)。
  const tau = (box.top - box.bottom) * TOP_CENTER_ANCHOR_MARGIN; // box 高 (y-up で top>bottom) × 係数
  if (p.leaderAnchor.y <= box.top + tau) return false;
  // 水平: アンカーが box の近縁 (pie 側の縦縁) を pie 側へ大きく越えていない = box のほぼ真上。
  // 越えていれば横ずれした側辺ラベルなので top-center は斜めになり不適 → side-center を維持。
  const overhang = Math.max(box.left - p.leaderAnchor.x, p.leaderAnchor.x - box.right, 0);
  return overhang <= TOP_CENTER_OVERHANG_MAX;
}

/**
 * placement が top-center attach の候補か (box を内部計算する emit 側用ラッパ)。emit の do-no-harm
 * (他ラベル box を貫かない時だけ採用) で「どの placement を試すか」の判定に使う。
 */
export function qualifiesTopCenterAttach(placement: Placement, cfg: PieLayoutConfig): boolean {
  return shouldAttachTopCenter(placement, placementBox(placement, cfg));
}

/**
 * placement から「描画される leader 折れ線 (`pathPoints`)」「貫通判定用折れ線 (`detectPathPoints`)」
 * 「暫定 `skipLeader`」を計算する。Pass 1 と conflict scorer で共有し、両者の leader 形状を
 * 厳密に一致させる (Pass 2 のクロス placement 判定は呼び出し側で行う)。
 */
export function computeDrawnLeader(
  placement: Placement,
  cfg: PieLayoutConfig,
  forScoring = false,
  allowTopCenter = false,
): { pathPoints: Pt[]; detectPathPoints: Pt[]; skipLeader: boolean } {
  // 常時描画 + 縦中央接続は **描画パスのみ** に適用する。conflict scorer (`chartConflicts`) から
  // `forScoring`=true で呼ばれた時は従来挙動を維持し、レイアウト選択 (その他 右/左 等) を baseline と
  // 同一に保つ (常時描画によるスコア変動でラベル位置が動くのを防ぐ)。
  // `allowTopCenter` は最終描画でのみ true。side-attach の top-center 化 (`shouldAttachTopCenter`) を
  // 許可するが、それ以外の経路 (scorer / realLeaderPaths 経由の metric / layout do-no-harm) は既定 false の
  // ため side-center 幾何のまま = baseline と一致し、ラベル位置に影響しない。
  const alwaysDraw = ALWAYS_DRAW_OUTSIDE_LEADERS && !forScoring;
  const endpointMinDist = cfg.pieRadius + radialFraction(cfg, 0.01, 0.1);
  const dominantOutsideLeaderGap = radialFraction(cfg, 0.3, 2.8);
  const dx = placement.x - placement.origTextX;
  const dy = placement.y - placement.origTextY;
  const endpoint = { x: placement.leaderEndpoint.x + dx, y: placement.leaderEndpoint.y + dy };
  const distFromCenter = Math.hypot(endpoint.x, endpoint.y);
  if (distFromCenter > 1e-9 && distFromCenter < endpointMinDist) {
    const factor = endpointMinDist / distFromCenter;
    endpoint.x *= factor;
    endpoint.y *= factor;
  }
  const finalBox = placementBox(placement, cfg);
  // declip ラベルでアンカーが box の真上/真下でなく横にあるケース (例 オフショア・人民元)。
  // 下の bend ロジックで折れ点なしの直線 (rim → 近端) にするため、endpoint 決定時に立てる。
  let declipSideAnchor = false;
  if (alwaysDraw) {
    // 接続点をラベル縦中央(1 行)/向きに応じた行位置(2 行)へ。終点 Y を target へ寄せると、
    // bendFollowsEndpointY 経路は最終水平セグメントが target Y に揃い、近い縦縁の縦中央で接続する。
    const lineCount = placement.lines.length >= 2 ? 2 : 1;
    const perLineHeight = labelHeightUnits(1, cfg);
    if (placement.forceTopRight) {
      // 上左帯の右上逃がし (その他 / topBandSmallRight / clusterTopBandBottomRight)。
      const capClearY = cfg.pieRadius + radialFraction(cfg, 0.012, 0.12);
      if (finalBox.bottom >= capClearY - 1e-9) {
        // 箱が完全に pie キャップより上 (topRightLiftedRimDraft): 通常の rim ラベルと同じく
        // 近い行中央へ短く接続する。水平区間が pie-y > pieRadius を保つためキャップは貫かない。
        endpoint.y = leaderAttachTargetY(finalBox, placement.leaderAnchor, lineCount, perLineHeight);
      } else {
        // 箱下端が円の y 域に入る旧経路: 水平区間が x=0 をパイ上で跨ぐため box 上端
        // (最大 pie-y) へ接続し、区間を pie-y > pieRadius に保ってキャップ貫通を避ける。
        endpoint.y = Math.max(finalBox.top, capClearY);
      }
    } else if (
      placement.item.lowerLeftDropLeader === true &&
      placement.dominantOutsideEdge &&
      placement.anchor === "end" &&
      placement.baseline === "top" &&
      (finalBox.top + finalBox.bottom) / 2 < placement.leaderAnchor.y
    ) {
      // オーストラリア型 (lowerLeftDropLeader): 円下のドロップ配置 2 行ラベル。従来は
      // leaderAttachTargetY で上行中央 Y へ寄せ truncate が右縁で接触 (= 右上接続) していた。
      // 接続点をラベル上縁の水平中央へ寄せる (斜めの円弦リルート経路は不変)。endpoint を
      // 「上縁の中央・cornerGap だけ上 (box 外)」に置くと、後段の chord リルート (W bend) →
      // truncate は線分を box 内へ延ばさず endpoint を返すため、中央上縁に cornerGap の
      // 隙間を空けて接続する。接触点は元の右縁より円から遠い中央寄りへ動くだけなので
      // 円貫通/交差は悪化しない。
      endpoint.x = (finalBox.left + finalBox.right) / 2;
      endpoint.y = finalBox.top + cfg.cornerGap; // 論理 y-up: top の少し上 (box 外)
    } else if (placement.declipBottomLeader) {
      // 縦 spread で動かしたラベル (`applyVerticalDeclipFallback`)。
      if (
        placement.leaderAnchor.x > finalBox.right ||
        placement.leaderAnchor.x < finalBox.left
      ) {
        // アンカーが box の真上/真下でなく **横** にあるケース (例 オフショア・人民元: 上左 rim で box の
        // 右辺=アンカー=pie 側)。水平中央へ寄せると L 字の水平区間が box 内へ食い込みラベル文字を貫く。
        // pie 側の縦縁 (近端) の行中央へ rim から **折れ点なしの直線** で接続する (下の bend ロジックで畳む)。
        declipSideAnchor = true;
        endpoint.x = placement.leaderAnchor.x > (finalBox.left + finalBox.right) / 2 ? finalBox.right : finalBox.left;
        endpoint.y = leaderAttachTargetY(finalBox, placement.leaderAnchor, lineCount, perLineHeight);
      } else {
        // アンカーが box の真上/真下: 長い斜めリーダーを見やすくするため接続点を **アンカー側の縁の
        // 水平中央** へ寄せる (上記 lowerLeftDrop 分岐のミラー)。アンカーが箱より下 (上へ動かした) なら
        // 下縁中央、上なら上縁中央。endpoint を縁の cornerGap だけ box 外に置き truncate が中央縁で止める。
        endpoint.x = (finalBox.left + finalBox.right) / 2;
        const anchorBelow = placement.leaderAnchor.y < (finalBox.top + finalBox.bottom) / 2;
        endpoint.y = anchorBelow ? finalBox.bottom - cfg.cornerGap : finalBox.top + cfg.cornerGap;
      }
    } else if (
      // 真下/真上中央の中央寄せラベルで、アンカー x が box 水平範囲内に入るケース
      // (例 中国 10.6% = 真下、ケイマン諸島 1.5% = 真上)。アンカー x が box 内だと L 字 leader の
      // bend (アンカー x 上に畳まれる) が box 内へ落ち、truncate が病的形状 (t0<=0) として切り詰めず
      // リーダが行内の文字に食い込む (`svg_geom.ts` の `truncateLeaderEndpointAtBox` 参照)。
      // 接続点を pie 側の上下縁の水平中央 (cornerGap だけ box 外) へ寄せると truncate は endpoint を
      // そのまま返し box 縁手前で止まる。box が下なら top 縁、上なら bottom 縁 (上記 declipBottom 分岐
      // と同じ向き判定)。アンカー x が box 外 (左右ラベル) は近い縦縁で正しく接続するため対象外。
      // anchor="middle" 限定で左右スタック (end/start) を除外。inside/forceTopRight/lowerLeftDrop/
      // declipBottom は先行分岐で捕捉済み。
      placement.anchor === "middle" &&
      placement.leaderAnchor.x > finalBox.left &&
      placement.leaderAnchor.x < finalBox.right
    ) {
      endpoint.x = (finalBox.left + finalBox.right) / 2;
      const boxBelowAnchor = (finalBox.top + finalBox.bottom) / 2 < placement.leaderAnchor.y;
      // box が下 → pie 側 = top 縁、box が上 → pie 側 = bottom 縁 の水平中央。
      endpoint.y = boxBelowAnchor ? finalBox.top + cfg.cornerGap : finalBox.bottom - cfg.cornerGap;
    } else if (allowTopCenter && shouldAttachTopCenter(placement, finalBox)) {
      // 汎用・自動判定 (例 イギリス・ポンド): 側辺中央 (右中央のふち) でなく box 上辺・水平中央へ
      // 接続する (lowerLeftDrop 分岐のミラー)。endpoint を上縁中央・cornerGap だけ box 外に置くと
      // 後段の W 弦リルート→truncate が線分を box 内へ延ばさず endpoint を返し、上縁中央へ隙間で
      // 接続する。ラベル位置・円貫通/交差判定は不変 (描画パス限定)。
      endpoint.x = (finalBox.left + finalBox.right) / 2;
      endpoint.y = finalBox.top + cfg.cornerGap; // 論理 y-up: top の少し上 (box 外)
    } else {
      endpoint.y = leaderAttachTargetY(finalBox, placement.leaderAnchor, lineCount, perLineHeight);
    }
  }
  let bend = placement.leaderBend;
  if (alwaysDraw && declipSideAnchor) {
    // 横アンカー (例 オフショア・人民元): bend をアンカーへ畳む。下の stub 除去で 2 点パス
    // [anchor, drawEndpoint] になり、rim から近端 (pie 側縦縁) の行中央へ折れ点なしの直線で繋ぐ。
    // 直線はアンカー (rim) から外側へ進むため円外を保ち、近端より外側で止まるので box も貫かない。
    bend = { x: placement.leaderAnchor.x, y: placement.leaderAnchor.y };
  } else if (alwaysDraw && placement.declipBottomLeader) {
    // L 字 (横優先): アンカーから水平にラベル側 (外側) へ出て、ラベル水平中央 x (`endpoint.x`) で縦に
    // 折れラベル縁へ。水平区間はアンカー (rim 上 dist≈`pieRadius`) から中心より遠い x へ進むので中心
    // 距離は単調増 = 円外を保つ。縦区間はラベル中央 x (左外側で |x|>`pieRadius`) なので円外。ゆえに
    // 下記 W 弦リルートは両区間とも円外で不発 (= 斜線化しない)、bend 1 回の素直な L 字になる。
    bend = { x: endpoint.x, y: placement.leaderAnchor.y };
  } else if (placement.leaderBendFollowsEndpointY) {
    const anchorY = placement.leaderAnchor.y;
    const minOffset = radialFraction(cfg, 0.005, 0.05);
    const rimDegenerate =
      Math.hypot(
        placement.leaderBend.x - placement.leaderEndpoint.x,
        placement.leaderBend.y - placement.leaderEndpoint.y,
      ) < 1e-9;
    const endpointOppositeSide =
      (anchorY < 0 && endpoint.y > anchorY) || (anchorY > 0 && endpoint.y < anchorY);
    if (placement.dominantOutsideEdge && rimDegenerate && endpointOppositeSide) {
      // 支配スライス rim ラベル (textX≈anchorX で bendFollowsEndpointY) のうち、接続点が anchor の
      // 反対側 Y にあるケース。anchorY±minOffset へ bend を寄せると anchor の手前へ後退する小フック
      // (逆向きスタブ) が出る (例 アメリカ・ドル58%)。bend を anchor に畳み anchor→接続点を素直な
      // 直線にする (truncate が近縁で止める)。下記 rim 縮退分岐と同形で、drawn パスは元の部分集合。
      bend = { x: placement.leaderAnchor.x, y: placement.leaderAnchor.y };
    } else if (anchorY > 0) bend = { x: bend.x, y: Math.max(endpoint.y, anchorY + minOffset) };
    else if (anchorY < 0) bend = { x: bend.x, y: Math.min(endpoint.y, anchorY - minOffset) };
  } else if (placement.leaderBendFollowsEndpointX) {
    const anchorX = placement.leaderAnchor.x;
    const anchorY = placement.leaderAnchor.y;
    const minOffset = radialFraction(cfg, 0.005, 0.05);
    if (anchorX > 0) bend = { x: Math.max(endpoint.x, anchorX + minOffset), y: anchorY };
    else if (anchorX < 0) bend = { x: Math.min(endpoint.x, anchorX - minOffset), y: anchorY };
  } else if (
    alwaysDraw &&
    Math.hypot(
      placement.leaderBend.x - placement.leaderEndpoint.x,
      placement.leaderBend.y - placement.leaderEndpoint.y,
    ) < 1e-9
  ) {
    // rim 縮退ケース (lineStart == lineEnd、bend≒box 角): anchor → 接続点 を直線で結ぶ。
    // bend を anchor に畳んで 3 点構造のまま直線にし、truncate が近縁の target Y 点で止める。
    bend = { x: placement.leaderAnchor.x, y: placement.leaderAnchor.y };
  } else {
    bend = clampBendOutsideBox(bend, placement.leaderAnchor.x, endpoint.x, finalBox);
  }
  // 常時描画では円貫通 leader を省略しない (下記 Pass の skip を通らない) ため、代わりに bend /
  // 接続点が円内へ食い込む場合だけ半径方向に円縁の外へ押し出し、「描画 leader は円を貫かない」
  // 不変条件を保つ。9/3 時付近で box 縁が僅かに円へ重なる near-rim ラベルの graze を解消する
  // (実幅化で顕在化)。既に円外の点は不変なので他 leader 形状に影響しない。
  const clampOutsidePie = (p: Pt): Pt => {
    const d = Math.hypot(p.x, p.y);
    if (d > 1e-9 && d < endpointMinDist) {
      const f = endpointMinDist / d;
      return { x: p.x * f, y: p.y * f };
    }
    return p;
  };
  if (alwaysDraw) bend = clampOutsidePie(bend);
  let drawEndpoint = truncateLeaderEndpointAtBox(bend, endpoint, finalBox, cfg.cornerGap);
  if (alwaysDraw) drawEndpoint = clampOutsidePie(drawEndpoint);
  let pathPoints = [placement.leaderAnchor, bend, drawEndpoint];
  let detectPathPoints = [placement.leaderAnchor, bend, endpoint];
  // 常時描画方針: inside のみ leaderless、円外は全て leader を描く。円貫通/hairpin の省略も無効化。
  if (alwaysDraw) {
    if (!placement.insideSlice) {
      // 円弦リルート: ラベルがアンカーの反対側へ移動した rim/leader 配置では bend の clamp が
      // 「極小スタブ → 長い斜め弦」を作り、弦が円を貫く。点の clampOutsidePie では防げないため、
      // 描画セグメントが円内 (countDefects と同じ pieRadius−1px 基準) を通る場合は bend を
      // アンカー角・接続点角の二等分方向の接線交点 W に置き換える。W = (rc/cos(Δ/2), 二等分角)
      // は両端への線分が中心から距離 ≥ pieRadius を保つことが幾何的に保証され、曲がりは 1 回の
      // まま (verify の max-1-bend 充足)。発火は既に円貫通している leader のみなので健全な
      // チャートの幾何は不変。forceTopRight は専用のキャップ回避経路を持つため対象外。
      const pxUnit = 1 / cfg.pxPerUnit;
      const intrudeR = cfg.pieRadius - pxUnit;
      const intrudes = (a: Pt, b: Pt): boolean =>
        distPointToSegment(0, 0, a.x, a.y, b.x, b.y) < intrudeR;
      const anchor = placement.leaderAnchor;
      if (
        !placement.forceTopRight &&
        (intrudes(anchor, bend) || intrudes(bend, drawEndpoint))
      ) {
        const thA = Math.atan2(anchor.y, anchor.x);
        const thE = Math.atan2(endpoint.y, endpoint.x);
        let dTh = thE - thA;
        while (dTh > Math.PI) dTh -= 2 * Math.PI;
        while (dTh < -Math.PI) dTh += 2 * Math.PI;
        // 角度差が大きすぎると W が極端に遠くなる (rc/cos(Δ/2) 発散)。150° 以上は現状維持。
        if (Math.abs(dTh) < LEADER_MAX_ANGULAR_DIFF_RAD) {
          const rc = cfg.pieRadius + 2.5 * pxUnit;
          const midTh = thA + dTh / 2;
          const rw = rc / Math.cos(Math.abs(dTh) / 2);
          bend = { x: rw * Math.cos(midTh), y: rw * Math.sin(midTh) };
          drawEndpoint = clampOutsidePie(
            truncateLeaderEndpointAtBox(bend, endpoint, finalBox, cfg.cornerGap),
          );
          pathPoints = [anchor, bend, drawEndpoint];
          detectPathPoints = [anchor, bend, endpoint];
        }
      }
      // 縮退スタブ除去: bend がアンカーに畳まれた後の clamp で生じる 1〜2px の幻セグメントは
      // 視認できない一方、他 leader との見かけ上の交差源になる。アンカー直結の 2 点パスにする。
      const stubEps = radialFraction(cfg, 0.02, 0.2);
      if (Math.hypot(bend.x - anchor.x, bend.y - anchor.y) < stubEps) {
        pathPoints = [anchor, drawEndpoint];
        detectPathPoints = [anchor, endpoint];
      }
    }
    // 「二分割」型の第2スライス (左) は rim 配置のまま leader を消す (スライス直近で冗長)。描画パス
    // のみで判定し scorer (forScoring) は不変に保つため、ラベル位置選択は baseline と同一 (線だけ消える)。
    return {
      pathPoints,
      detectPathPoints,
      skipLeader: placement.insideSlice || Boolean(placement.bisectedSecondSliceNoLeader),
    };
  }
  let skipLeader = Boolean(placement.skipLeader);
  if (skipLeader && placement.dominantOutsideEdge) {
    const a = placement.leaderAnchor;
    if (Math.hypot(endpoint.x - a.x, endpoint.y - a.y) > dominantOutsideLeaderGap) skipLeader = false;
  }
  if (!skipLeader && placement.upperLeftHairpinCheck) {
    const a = placement.leaderAnchor;
    const b = placement.leaderBend;
    const seg1x = b.x - a.x;
    const seg2x = endpoint.x - b.x;
    const seg2y = endpoint.y - b.y;
    const len1 = Math.abs(seg1x);
    const len2 = Math.hypot(seg2x, seg2y);
    if (len1 > 1e-6 && len2 > 1e-6) {
      const cosAngle = (seg1x * seg2x) / (len1 * len2);
      skipLeader = cosAngle < UPPER_LEFT_HAIRPIN_VISIBILITY_COS_THRESHOLD;
    }
  }
  // 円を貫通する leader は省略する。anchor は円縁上(dist≈pieRadius)なので外向きの
  // 通常 leader は引っかからず、円内へ食い込むセグメントだけを落とす。
  // 線を消すだけなので新規の重なり/交差/はみ出しは生じない。
  if (!skipLeader) {
    const pieClear = cfg.pieRadius - 2 / (cfg.mmPerUnit * cfg.svgUnitsPerMm);
    for (let k = 0; k + 1 < pathPoints.length; k += 1) {
      if (distPointToSegment(0, 0, pathPoints[k].x, pathPoints[k].y, pathPoints[k + 1].x, pathPoints[k + 1].y) < pieClear) {
        skipLeader = true;
        break;
      }
    }
  }
  return { pathPoints, detectPathPoints, skipLeader };
}

/**
 * 上左 ([90°,135°]) の小スライスが引く「短い」leader か。短い = ラベルが自スライスのすぐ外側に
 * あり、線が無くても接続が自明 (ユーザー指摘: REIT 国別の シンガポール 3.5%)。本判定は emit 最終段
 * (Pass 2.6) だけで使い、`computeDrawnLeader` / 採点には載せない。これにより leader 線を消すだけで
 * レイアウト選択や他 leader の交差解決には一切影響しない (ラベル位置は不変)。閾値 (≈0.5·R) で
 * 「その他」級の右逃がし leader (≈1.2·R) や遠方へ逃がした leader は残す。述語 (`isSmall` / `midAngle`>90 /
 * 帯内 / 非「その他」) は `layout.ts` の `markTopBandSmallRight` の候補条件と同系。
 */
export function isRedundantUpperLeftSmallLeader(
  placement: Placement,
  pathPoints: Pt[],
  cfg: PieLayoutConfig,
): boolean {
  const it = placement.item;
  const mid = it.midAngle ?? 0;
  // 意図的に rank 9 へ強制した leader (forceOutsideLeader) は「冗長な短 leader」ではないので
  // 対象外。これを消すと強制した目的 (極小スライスへの leader 付与) が無に帰す。
  if (it.forceOutsideLeader === true) return false;
  if (it.isSmall !== true) return false;
  if (mid <= 90) return false;
  if (!angleInBand(normalizeAngle(mid), 90, UPPER_LEFT_SMALL_LEADER_HALF_WIDTH_DEG)) return false;
  if (isOtherCategory(it.name)) return false;
  let len = 0;
  for (let k = 0; k + 1 < pathPoints.length; k += 1) {
    len += Math.hypot(pathPoints[k + 1].x - pathPoints[k].x, pathPoints[k + 1].y - pathPoints[k].y);
  }
  return len < radialFraction(cfg, 0.5, 4.8);
}

/**
 * 1 強 (≥`REDUNDANT_RIM_LEADER_DOMINANT_MIN_PCT`%) スライスの `dominantOutsideEdge` rim ラベル
 * (`buildOutsideRimDraft` 由来、draft では `skipLeader=true` を意図) が引く「冗長な短い」leader か。
 * 短い = ラベルが自スライス外縁に隣接し線が無くても接続が自明 (ユーザー指摘: アメリカ・ドル58%)。
 * `ALWAYS_DRAW_OUTSIDE_LEADERS` 下では `computeDrawnLeader` が rim ラベルにも一律 leader を描くため、
 * emit 最終段でこの述語により線のみ削る。閾値は `computeDrawnLeader` の `dominantOutsideLeaderGap`
 * (= `radialFraction(cfg, 0.3, 2.8)`、行 54・行 239) と同基準。これより遠くへ逃げた rim ラベルは leader を
 * 残す (接続が自明でない)。**対象を 1 強スライスに限る**のが要点: バランス型チャートの中サイズ各スライス
 * (>`smallSliceThreshold` だが非 dominant) の短い rim leader は「なるべく leader を使う」(`ALWAYS_DRAW`) 方針
 * どおり残し、唯一無二で識別が自明な 1 強スライス (例 58%) の冗長スタブだけを省く。`forceOutsideLeader`
 * (far-sliver の意図的 leader) と `forceTopRight` (その他の右上逃がし、専用キャップ回避経路) も除外。
 * 本判定は emit (Pass 1.5) だけで使い、`computeDrawnLeader` / 採点には載せない (ラベル位置不変)。
 */
export function isRedundantDominantRimLeader(
  placement: Placement,
  pathPoints: Pt[],
  cfg: PieLayoutConfig,
): boolean {
  if (!placement.dominantOutsideEdge || placement.insideSlice) return false;
  if ((placement.item.percent ?? 0) < REDUNDANT_RIM_LEADER_DOMINANT_MIN_PCT) return false;
  if (placement.item.forceOutsideLeader === true) return false;
  if (placement.forceTopRight === true) return false;
  if (pathPoints.length < 2) return false;
  const a = pathPoints[0];
  const e = pathPoints[pathPoints.length - 1];
  return Math.hypot(e.x - a.x, e.y - a.y) <= radialFraction(cfg, 0.3, 2.8);
}

/**
 * 描画される leader 同士が交差する場合、長い方を省略する (skip[i]=true)。leader を消すだけ
 * なので新たな重なり/はみ出し/交差は生じない (Pass 2 の leader×box 省略と同性質, 退行0)。
 * emit (Pass 2 直後) と `chartConflicts` の両方から呼び、採点と描画の leader 集合を一致させる。
 * 短い leader を残す = ラベルが自スライス近傍にあり接続が自明。同長は name で決定的に。
 * entries は pixel 座標の折れ線 (pixPaths) と name を持ち、skip[] を破壊的に更新する。
 */
export function resolveLeaderCrossings(pixPaths: (Pt[] | null)[], names: string[], skip: boolean[]): void {
  const n = pixPaths.length;
  const lenOf = (pts: Pt[]): number => {
    let s = 0;
    for (let k = 0; k + 1 < pts.length; k += 1) {
      s += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    }
    return s;
  };
  for (let i = 0; i < n; i += 1) {
    const pa = pixPaths[i];
    if (!pa || skip[i]) continue;
    for (let j = i + 1; j < n; j += 1) {
      const pb = pixPaths[j];
      if (!pb || skip[j]) continue;
      let cross = false;
      for (let k = 0; k + 1 < pa.length && !cross; k += 1) {
        for (let m = 0; m + 1 < pb.length && !cross; m += 1) {
          if (segmentsIntersect(pa[k], pa[k + 1], pb[m], pb[m + 1])) cross = true;
        }
      }
      if (!cross) continue;
      const la = lenOf(pa);
      const lb = lenOf(pb);
      const dropI = la > lb || (la === lb && names[i] > names[j]);
      if (dropI) {
        skip[i] = true;
        break; // i は消えたので次の i へ
      }
      skip[j] = true;
    }
  }
}

/** 点 (px,py) と線分 (ax,ay)-(bx,by) の最短距離。 */
export function distPointToSegment(
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

export type Coord = {
  xScale: (v: number) => number;
  yScale: (v: number) => number;
  width: number;
  height: number;
};

// -----------------------------------------------------------------------------
// 実描画 leader パスを横断して数える「不具合量」メトリクス層。emit / scorer / 各後処理の
// do-no-harm ゲートが共有する (verify と同じ実描画パス幾何で判定)。
// -----------------------------------------------------------------------------

/** 折れ線 2 本が交差するか (verify と同じ実描画パス幾何で判定)。 */
export function pathsCross(pa: Pt[], pb: Pt[]): boolean {
  for (let k = 0; k + 1 < pa.length; k += 1) {
    for (let m = 0; m + 1 < pb.length; m += 1) {
      if (segmentsIntersect(pa[k], pa[k + 1], pb[m], pb[m + 1])) return true;
    }
  }
  return false;
}

/**
 * 各 placement の実描画 leader パスを **pixel 座標** で返す (skip は null)。emit と同じ
 * `computeDrawnLeader` の logical パスを `xScale`/`yScale` で pixel へ変換する。交差判定 `segmentsIntersect`
 * の許容差 (0.5) は pixel 想定なので、logical のまま渡すと常に非交差になる (要 pixel 変換)。
 */
export function realLeaderPaths(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): (Pt[] | null)[] {
  return placements.map((p) => {
    const r = computeDrawnLeader(p, cfg, false);
    if (r.skipLeader) return null;
    return r.pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
  });
}

/** 実描画 leader 同士が交差する対の数 (verify の "leader crossing" と同条件・pixel 空間)。 */
export function countLeaderCrossings(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): number {
  const paths = realLeaderPaths(placements, cfg, coord);
  let c = 0;
  for (let i = 0; i < paths.length; i += 1) {
    const pa = paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < paths.length; j += 1) {
      const pb = paths[j];
      if (pb && pathsCross(pa, pb)) c += 1;
    }
  }
  return c;
}

/** 実描画 leader が自分以外のラベル box を貫く件数 (verify の "leader through label" と同条件・pixel)。 */
export function countLeaderThroughLabels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = projectBoxesToPixels(placements, cfg, coord);
  let c = 0;
  for (let i = 0; i < paths.length; i += 1) {
    const pts = paths[i];
    if (!pts) continue;
    for (let j = 0; j < placements.length; j += 1) {
      if (j === i) continue;
      if (leaderCrossesBox(pts, boxes[j])) c += 1;
    }
  }
  return c;
}

// -----------------------------------------------------------------------------
// 後処理 (角度順整列 / 各種 escape / 修復) の do-no-harm ゲートで共通に使う「不具合量」計測。
// これらはどの後処理関数でも「全 placement を横断し最大侵入/重なり/はみ出しを測る」純関数。
// -----------------------------------------------------------------------------

/** 全 placement 対の最大縦重なり量 (logical, X が重なる対のみ)。do-no-harm の ovl 指標。 */
export function boxOverlapMax(placements: Placement[], cfg: PieLayoutConfig): number {
  let m = 0;
  for (let i = 0; i < placements.length; i += 1) {
    const a = placementBox(placements[i], cfg);
    for (let j = i + 1; j < placements.length; j += 1) {
      const b = placementBox(placements[j], cfg);
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (ox > 0 && oy > 0) m = Math.max(m, oy);
    }
  }
  return m;
}

/** 円外ラベル box の pie 円 (中心=logical 原点) への最大侵入深さ (logical)。verify "label inside pie" のゲート。 */
export function boxPieIntrusionMax(placements: Placement[], cfg: PieLayoutConfig): number {
  let m = 0;
  for (const p of placements) {
    if (p.insideSlice) continue;
    const bx = placementBox(p, cfg);
    const nx = Math.max(bx.left, Math.min(bx.right, 0));
    const ny = Math.max(bx.bottom, Math.min(bx.top, 0));
    m = Math.max(m, cfg.pieRadius - Math.hypot(nx, ny));
  }
  return m;
}

/** 1 つの placement box の viewBox はみ出し量 (pixel, 4 辺の最大。負=内側はそのまま負値)。 */
export function boxViewOverflowOf(p: Placement, cfg: PieLayoutConfig, coord: Coord): number {
  const lb = placementBox(p, cfg);
  const left = Math.min(coord.xScale(lb.left), coord.xScale(lb.right));
  const right = Math.max(coord.xScale(lb.left), coord.xScale(lb.right));
  const top = Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom));
  const bottom = Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom));
  return Math.max(-left, right - coord.width, -top, bottom - coord.height);
}

/** 全 placement box の viewBox はみ出し量の最大 (pixel, 0 下限)。 */
export function boxViewOverflowMax(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): number {
  let m = 0;
  for (const p of placements) m = Math.max(m, boxViewOverflowOf(p, cfg, coord));
  return Math.max(0, m);
}

/** placement box を pixel 空間の {left,right,top,bottom} へ射影した配列 (leader×box 貫通判定の前処理)。 */
export function projectBoxesToPixels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): { left: number; right: number; top: number; bottom: number }[] {
  return placements.map((p) => {
    const lb = placementBox(p, cfg);
    return {
      left: Math.min(coord.xScale(lb.left), coord.xScale(lb.right)),
      right: Math.max(coord.xScale(lb.left), coord.xScale(lb.right)),
      top: Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom)),
      bottom: Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom)),
    };
  });
}

/** いずれかの点が viewBox を 1px 超はみ出す leader の本数 (do-no-harm の oob 指標)。 */
export function oobLeaderCount(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): number {
  const paths = realLeaderPaths(placements, cfg, coord);
  let c = 0;
  for (const pts of paths) {
    if (!pts) continue;
    for (const q of pts) {
      if (q.x < -1 || q.x > coord.width + 1 || q.y < -1 || q.y > coord.height + 1) {
        c += 1;
        break;
      }
    }
  }
  return c;
}

/** verify と同基準で各円外ラベルの {labelY, anchorY} (pixel) を左右スタックに分けて返す。 */
export function angularStacks(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): { left: { labelY: number; anchorY: number }[]; right: { labelY: number; anchorY: number }[] } {
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const paths = realLeaderPaths(placements, cfg, coord);
  const left: { labelY: number; anchorY: number }[] = [];
  const right: { labelY: number; anchorY: number }[] = [];
  placements.forEach((p, i) => {
    if (p.insideSlice) return;
    // 意図的に角度順を破る/固定する その他 のみ除外する: コア帯 (右上逃がし or 真上垂直) と
    // 左拡張帯 (常に真上垂直 center 固定。アンカー最上・ラベル天井固定で構造的に concordant)、
    // および forceTopRight。帯外 (>122°) で左右スタックに通常 rim 配置された その他 は順序
    // チェックに参加させる (除外すると下位スタックでの逆転が見逃される)。
    if (
      isOtherCategory(p.item.name) &&
      (topBandSonohokaZone(p.item) !== null || p.forceTopRight)
    ) {
      return;
    }
    const pts = paths[i];
    if (!pts || pts.length < 2) return;
    const head = pts[0];
    const tail = pts[pts.length - 1];
    const anchor =
      Math.hypot(head.x - cx, head.y - cy) <= Math.hypot(tail.x - cx, tail.y - cy) ? head : tail;
    // 縦位置は生の `p.y` でなく box 縦中心で測る: baseline 逆向きの back-to-back 対 (例 イギリス/
    // イタリア) は両者の `p.y` がほぼ同値でも box 中心は上下に大きく離れ、視覚的な縦順序は box 中心で
    // しか判定できない。単一 baseline の通常スタックでは box 中心順 == `p.y` 順なので指標は不変。
    const box = placementBox(p, cfg);
    const entry = { labelY: coord.yScale((box.top + box.bottom) / 2), anchorY: anchor.y };
    (coord.xScale(p.x) < cx ? left : right).push(entry);
  });
  return { left, right };
}

/**
 * 角度順の **discordant 対 (Kendall) の総数**: ラベル y 昇順で上に居るのにアンカーが下 (anchorY が
 * 2px 超で大きい) という対を**全対**で数える。verify の隣接逆転 (adjacent descent) と違い、3 要素
 * 以上の乱れでも 1 回の隣接スワップごとに厳密に減るため、untangle のバブル進行判定に使う (隣接指標
 * だと逆転が別対へ移るだけで総数が減らず採用されない)。
 */
export function countAngularDiscordantPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  const { left, right } = angularStacks(placements, cfg, coord);
  let dis = 0;
  for (const arr of [left, right]) {
    arr.sort((a, b) => a.labelY - b.labelY);
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        if (arr[j].anchorY < arr[i].anchorY - 2) dis += 1;
      }
    }
  }
  return dis;
}
