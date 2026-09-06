// =============================================================================
// svg_export/leader_geometry.ts — leader 折れ線の幾何プリミティブ
// -----------------------------------------------------------------------------
// placement から「実際に描画される leader パス」を計算する純幾何層。
// cascade / repair / scoring など上位の配置ロジックはこれらを一方向に呼ぶだけで、
// 本モジュールは `geometry.ts` / 型のみに依存する (上位への逆依存なし = 循環なし)。
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
  pxToLogical,
} from '../layout/geometry.js';
import { topBandSonohokaZone } from '../layout/placement.js';
import type { BBox } from '../layout/geometry.js';
import type { Placement, PieLayoutConfig } from '../types.js';

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
// 「冗長な短い leader」を省く対象を 1 強スライスに限る下限 (%)。`layout/placement.ts` の
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

// 側辺 rim ラベルの 2 点直線 leader が円周にほぼ接する (tangent-hugging) のを W リルートで
// 持ち上げる発火閾値。描画セグメント方向と anchor 半径方向の |内積| がこの値未満 = ほぼ接線
// (実測 D=0.142 / E=0.107 / F=0.095 が < 0.25)。健全な放射 leader (内積≈1) は非発火。
const NEAR_TANGENT_DOT_RADIAL_MAX = 0.25;

// 「rim 貼り付きの短い leader」(`isShortRimHuggingLeader`) の接線性しきい値。cos(60°) = 先頭セグメントが
// **放射方向より接線方向に近い** 境界そのもので、「rim から素直に外へ出ていない」を幾何的に言い切る値。
// 上の `NEAR_TANGENT_DOT_RADIAL_MAX` (持ち上げ発火用) とは目的が違うので独立定数にする。
const SHORT_RIM_LEADER_DOT_RADIAL_MAX = Math.cos((60 * Math.PI) / 180);

// 短スタブが「束になっている」判定 (`countBundledRimStubs`)。先頭セグメントの単位ベクトルの内積が
// この値超 (= なす角 20°以内 → ほぼ平行) で、かつ rim アンカー同士が `pieRadius` のこの倍率以内
// (= 円弧上で隣接と言える距離) なら束とみなす。どちらもチャート寸法に対する相対量。
const BUNDLED_RIM_STUB_MIN_DIR_COS = Math.cos((20 * Math.PI) / 180);
const BUNDLED_RIM_STUB_MAX_ANCHOR_GAP_FACTOR = 0.4;

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
  if (p.anchor === 'middle') return false; // 真上/真下の中央寄せは対象外
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
 * placement が side-edge-center attach (Pass 1e) の候補か。左右 (start/end) ラベルのアンカー x が
 * 自 box の水平範囲内に食い込む = 既定の側辺接続だと「アンカー x で縦降下 → 近縁へ後退する水平尾」
 * になり、縦区間が自ラベルをかすめ/貫き、水平尾がラベルの伸長方向と逆へ伸びて見える defect
 * (例 country_long_labels_9 ドイツ連邦共和国 / country_12_europe_heavy デンマーク) の述語そのもの。
 * 通常の側辺ラベル (アンカー x が box 外) は非発火。
 */
export function qualifiesSideEdgeCenterAttach(placement: Placement, cfg: PieLayoutConfig): boolean {
  if (placement.insideSlice || placement.forceTopRight) return false;
  if (placement.anchor === 'middle') return false;
  // declip ラベルは `computeDrawnLeader` 先行分岐の専用接続 (declipSideAnchor / 縁中央) を持つ。
  // ここで対象にすると Pass 1e の再計算 (allowDiagonal=false) が Pass 1d の斜め畳みを
  // 横優先 L 字へ巻き戻す退行を起こす (例 currency_europe_heavy_8 ノルウェー/デンマーククローネ)。
  if (placement.declipBottomLeader) return false;
  const box = placementBox(placement, cfg);
  return placement.leaderAnchor.x > box.left && placement.leaderAnchor.x < box.right;
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
  allowGrazeLift = false,
  allowDiagonal = false,
  allowSideEdgeCenter = false,
): { pathPoints: Pt[]; detectPathPoints: Pt[]; skipLeader: boolean } {
  // 常時描画 + 縦中央接続は **描画パスのみ** に適用する。conflict scorer (`chartConflicts`) から
  // `forScoring`=true で呼ばれた時は従来挙動を維持し、レイアウト選択 (その他 右/左 等) を baseline と
  // 同一に保つ (常時描画によるスコア変動でラベル位置が動くのを防ぐ)。
  // `allowTopCenter` は最終描画でのみ true。side-attach の top-center 化 (`shouldAttachTopCenter`) を
  // 許可するが、それ以外の経路 (scorer / realLeaderPaths 経由の metric / layout do-no-harm) は既定 false の
  // ため side-center 幾何のまま = baseline と一致し、ラベル位置に影響しない。
  // `allowGrazeLift` も同様に最終描画 (`pipeline.ts` の Pass 1c) でのみ true。3 点 leader の先頭セグメントが
  // 円周に接するのを W リルートで持ち上げる (下記参照)。realLeaderPaths/scorer/layout は既定 false の
  // ため `pathPoints` が baseline と一致し、`countLeaderCrossings` 経由のラベル位置選択に影響しない。
  // `allowDiagonal` も最終描画 (`pipeline.ts` の Pass 1d) でのみ true。水平先行 L 字
  // (`leaderBendFollowsEndpointX`) の bend をアンカーへ畳み、アンカー → 接続点の 2 点斜め直線にする
  // (下記参照)。既定 false のため realLeaderPaths/scorer/layout の幾何は baseline と一致し、
  // ラベル位置・採点に影響しない。
  // `allowSideEdgeCenter` も最終描画 (`pipeline.ts` の Pass 1e) でのみ true。左右 (start/end) ラベルで
  // アンカー x が box 水平範囲内に食い込むときの接続を書き出し側の縦縁・縦中央 (9 時/3 時) へ
  // 切替える (下記参照)。既定 false のため同じく baseline 幾何 = ラベル位置・採点に影響しない。
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
  if (alwaysDraw && placement.sideCenterLeader && placement.anchor !== 'middle') {
    // 明示オプトイン (`applyLeftStackClusterEvenSpread` の移動ラベル): 書き出し側の
    // 縦縁 (end=右縁の 3 時) へ「アンカー → 接続点」の 2 点直線で接続し、**下流の汎用機構
    // (clampOutsidePie / W 弦リルート / truncate) を通さず確定する**。クラスタ移動ラベルの rim 沿い
    // 斜線は W リルートで pie+マージン環 (r≈1.1) まで外へ押されると上隣ラベル箱の角を掠め、attach
    // 退避でもラベル右シフトでも解けない (実測: currency_many_small_10 イギリスポンド × 豪ドル)。
    // アンカーは rim 上 (r=1.0)・接続点は箱の cornerGap 外なので、素の直線は接線状に rim へ触れ得て
    // も 1px 級の食い込みに留まり pie-through 判定 (pieRadius−1px) には掛からない。大きく弦を張る
    // 幾何が生じた場合は後段 do-no-harm ゲートが pie 悪化として全 revert する。
    // Y は seed (`leaderEndpoint.y`+dy) を box 縦範囲へクランプして使う — 既定は縦中央だが、斜線が
    // 隣接ラベル箱を掠める時に呼び出し側が上下へ退避できる (豪ドル×カナダドル)。
    const scEnd = {
      x:
        placement.anchor === 'start'
          ? finalBox.left - cfg.cornerGap
          : finalBox.right + cfg.cornerGap,
      y: Math.min(
        finalBox.top - cfg.cornerGap,
        Math.max(finalBox.bottom + cfg.cornerGap, endpoint.y),
      ),
    };
    return {
      pathPoints: [placement.leaderAnchor, scEnd],
      detectPathPoints: [placement.leaderAnchor, scEnd],
      skipLeader: false,
    };
  }
  // declip ラベルでアンカーが box の真上/真下でなく横にあるケース (例 オフショア・人民元)。
  // 下の bend ロジックで折れ点なしの直線 (rim → 近端) にするため、endpoint 決定時に立てる。
  let declipSideAnchor = false;
  // side-edge-center 分岐 (allowSideEdgeCenter) が発火したケース。下の bend ロジックで近縁外側 x の
  // 横優先 L 字にするため、endpoint 決定時に立てる。
  let sideEdgeAttach = false;
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
        endpoint.y = leaderAttachTargetY(
          finalBox,
          placement.leaderAnchor,
          lineCount,
          perLineHeight,
        );
      } else {
        // 箱下端が円の y 域に入る場合: 水平区間が x=0 をパイ上で跨ぐため box 上端
        // (最大 pie-y) へ接続し、区間を pie-y > pieRadius に保ってキャップ貫通を避ける。
        endpoint.y = Math.max(finalBox.top, capClearY);
      }
    } else if (
      placement.item.lowerLeftDropLeader === true &&
      placement.dominantOutsideEdge &&
      placement.anchor === 'end' &&
      placement.baseline === 'top' &&
      (finalBox.top + finalBox.bottom) / 2 < placement.leaderAnchor.y
    ) {
      // オーストラリア型 (lowerLeftDropLeader): 円下のドロップ配置 2 行ラベル。
      // leaderAttachTargetY で上行中央 Y へ寄せると truncate が右縁で接触 (= 右上接続) する
      // ため、接続点をラベル上縁の水平中央へ寄せる (斜めの円弦リルート経路は不変)。endpoint を
      // 「上縁の中央・cornerGap だけ上 (box 外)」に置くと、後段の chord リルート (W bend) →
      // truncate は線分を box 内へ延ばさず endpoint を返すため、中央上縁に cornerGap の
      // 隙間を空けて接続する。接触点は右縁接続より円から遠い中央寄りへ動くだけなので
      // 円貫通/交差は悪化しない。
      endpoint.x = (finalBox.left + finalBox.right) / 2;
      endpoint.y = finalBox.top + cfg.cornerGap; // 論理 y-up: top の少し上 (box 外)
    } else if (placement.declipBottomLeader) {
      // 縦 spread で動かしたラベル (`applyVerticalDeclipFallback`)。
      if (placement.leaderAnchor.x > finalBox.right || placement.leaderAnchor.x < finalBox.left) {
        // アンカーが box の真上/真下でなく **横** にあるケース (例 オフショア・人民元: 上左 rim で box の
        // 右辺=アンカー=pie 側)。水平中央へ寄せると L 字の水平区間が box 内へ食い込みラベル文字を貫く。
        // pie 側の縦縁 (近端) の行中央へ rim から **折れ点なしの直線** で接続する (下の bend ロジックで畳む)。
        declipSideAnchor = true;
        endpoint.x =
          placement.leaderAnchor.x > (finalBox.left + finalBox.right) / 2
            ? finalBox.right
            : finalBox.left;
        endpoint.y = leaderAttachTargetY(
          finalBox,
          placement.leaderAnchor,
          lineCount,
          perLineHeight,
        );
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
      // リーダが行内の文字に食い込む (`layout/geometry.ts` の `truncateLeaderEndpointAtBox` 参照)。
      // 接続点を pie 側の上下縁の水平中央 (cornerGap だけ box 外) へ寄せると truncate は endpoint を
      // そのまま返し box 縁手前で止まる。box が下なら top 縁、上なら bottom 縁 (上記 declipBottom 分岐
      // と同じ向き判定)。アンカー x が box 外 (左右ラベル) は近い縦縁で正しく接続するため対象外。
      // anchor="middle" 限定で左右スタック (end/start) を除外。inside/forceTopRight/lowerLeftDrop/
      // declipBottom は先行分岐で捕捉済み。
      placement.anchor === 'middle' &&
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
    } else if (
      // 左右 (start/end) ラベルでアンカー x が box 水平範囲内に食い込むケース (例
      // country_long_labels_9 ドイツ連邦共和国 = 右下 start、country_12_europe_heavy デンマーク =
      // 上帯 end)。rim 縮退 placement が横シフトされアンカーが近縁を僅かに越えると、既定の側辺
      // 接続は「アンカー x で縦降下 → 近縁へ後退する水平尾」になり、縦区間が自ラベルを貫き
      // 水平尾がラベルの伸長方向と逆へ伸びて見える。接続を**書き出し側の縦縁・縦中央**
      // (start=左縁の 9 時 / end=右縁の 3 時、cornerGap だけ縁の外) へ切替え、下の bend ロジック
      // (`sideEdgeAttach`) が近縁外側 x で縦に降ろす横優先 L 字にする。
      // 発火は Pass 1e (do-no-harm 採用) のみで、通常の側辺ラベル (アンカー x が box 外) は不変。
      allowSideEdgeCenter &&
      placement.anchor !== 'middle' &&
      placement.leaderAnchor.x > finalBox.left &&
      placement.leaderAnchor.x < finalBox.right
    ) {
      sideEdgeAttach = true;
      endpoint.x =
        placement.anchor === 'start'
          ? finalBox.left - cfg.cornerGap
          : finalBox.right + cfg.cornerGap;
      endpoint.y = (finalBox.top + finalBox.bottom) / 2;
    } else {
      endpoint.y = leaderAttachTargetY(finalBox, placement.leaderAnchor, lineCount, perLineHeight);
    }
  }
  let bend = placement.leaderBend;
  if (alwaysDraw && sideEdgeAttach) {
    // side-edge-center (9 時/3 時) 接続: アンカーから近縁の外側 x (`endpoint.x`) へ短く水平に出て、
    // 縁に沿って縦に降り縦中央で止まる横優先 L 字。アンカーは縁を僅かに越えた位置なので水平区間は
    // 数 px。pie 側へ出る場合は下の clampOutsidePie / W 弦リルートが円外を保証し、縦区間は縁の外側
    // (box 非貫通) を通る。bendFollowsY/X より優先 (rim 縮退 placement は両フラグ true のため)。
    bend = { x: endpoint.x, y: placement.leaderAnchor.y };
  } else if (alwaysDraw && declipSideAnchor) {
    // 横アンカー (例 オフショア・人民元): bend をアンカーへ畳む。下の stub 除去で 2 点パス
    // [anchor, drawEndpoint] になり、rim から近端 (pie 側縦縁) の行中央へ折れ点なしの直線で繋ぐ。
    // 直線はアンカー (rim) から外側へ進むため円外を保ち、近端より外側で止まるので box も貫かない。
    bend = { x: placement.leaderAnchor.x, y: placement.leaderAnchor.y };
  } else if (alwaysDraw && placement.declipBottomLeader) {
    if (allowDiagonal) {
      // 斜め直線化 (描画のみ): 下の L 字は「アンカー高さで水平 → ラベル縁中央で垂直」の 2 折れが
      // 遠回りに見える (例 currency_europe_heavy_8 ノルウェー/デンマーク)。bend をアンカーへ畳み、
      // アンカー → 縁中央接続点の 2 点斜線にする。円へ食い込む場合は下の W 弦リルートが 3 点へ
      // 戻すため、呼び出し側 (Pass 1d) は「2 点になった時だけ」採用して安全側に倒す。
      bend = { x: placement.leaderAnchor.x, y: placement.leaderAnchor.y };
    } else {
      // L 字 (横優先): アンカーから水平にラベル側 (外側) へ出て、ラベル水平中央 x (`endpoint.x`) で縦に
      // 折れラベル縁へ。水平区間はアンカー (rim 上 dist≈`pieRadius`) から中心より遠い x へ進むので中心
      // 距離は単調増 = 円外を保つ。縦区間はラベル中央 x (左外側で |x|>`pieRadius`) なので円外。ゆえに
      // 下記 W 弦リルートは両区間とも円外で不発 (= 斜線化しない)、bend 1 回の素直な L 字になる。
      bend = { x: endpoint.x, y: placement.leaderAnchor.y };
    }
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
    if (allowDiagonal && alwaysDraw) {
      // 斜め直線化 (描画のみ): 水平先行 L 字 (例 currency_europe_heavy_8 ノルウェー/デンマーク) は
      // 「アンカー高さで水平 → ラベル手前で垂直」の 2 折れが遠回りに見えるため、bend をアンカーへ
      // 畳む。下の縮退スタブ除去が 2 点 [anchor, drawEndpoint] へ畳み、truncate が box 縁 cornerGap
      // 手前で止める素直な斜線になる。斜線が円へ食い込む場合は下の W 弦リルートが 3 点テントへ
      // 戻すため、呼び出し側 (Pass 1d) は「2 点になった時だけ」採用して安全側に倒す。
      bend = { x: anchorX, y: anchorY };
    } else if (anchorX > 0) bend = { x: Math.max(endpoint.x, anchorX + minOffset), y: anchorY };
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
      if (!placement.forceTopRight && (intrudes(anchor, bend) || intrudes(bend, drawEndpoint))) {
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
      // side-edge-center 接続でアンカー y が縁の縦中央と一致すると bend が endpoint と厳密一致し
      // 末尾に零長セグメントが残る。視認不能だが重複点はパス肥大と見かけ上の交差源になるため
      // 2 点へ畳む。既存経路の出力を変えないよう allowSideEdgeCenter 限定 (byte 不変)。
      if (
        allowSideEdgeCenter &&
        pathPoints.length === 3 &&
        Math.hypot(pathPoints[1].x - pathPoints[2].x, pathPoints[1].y - pathPoints[2].y) < 1e-9
      ) {
        pathPoints = [pathPoints[0], pathPoints[2]];
        detectPathPoints = [detectPathPoints[0], detectPathPoints[2]];
      }
      // 近接線グレイズ (3 点 leader 版): 先頭セグメント anchor→bend が円周のすぐ外 (intrudeR 以上=
      // 非貫通) をほぼ接線方向になぞり「rim に溶ける」ケースを、上の `intrudes` リルートと同じ W
      // (二等分接線交点) へ bend を差し替えて小さく持ち上げる (例 currency_many_small_10「イギリス
      // ポンド」: 左 rim の縦スタックに押された box が side-center 接続でアンカーの真下へ降り、先頭
      // セグメントが x≈-pieRadius で円左端を縦になぞる)。anchor が rim 上だと W テント先頭セグメント
      // a→W も二等分接線ゆえ minR≈pieRadius に固定され持ち上がらないため、その場合は 2 点版と同形の
      // 放射スタブ (anchor をスライス角内でラベル側へクランプ) へフォールバックする (下記)。上の `intrudes` ゲートは `pieRadius`−`pxUnit`
      // 未満の貫通のみ捕えるため半径 ≈ `pieRadius` のグレイズはすり抜ける。発火は (1) `allowGrazeLift`
      // (最終描画 Pass 1c のみ), (2) 3 点 leader, (3) rim 上 anchor, (4) 先頭セグメントが
      // [`intrudeR`, `pieRadius`+薄帯) の接線グレイズ の論理積。`pathPoints.length===3` 限定で下の
      // 2 点 tangent 分岐とは排他。スタブ除去後に置き、生成した 3 点が再度畳まれないようにする。
      // `allowGrazeLift` 既定 false のため realLeaderPaths/scorer/layout からは不可視 = ラベル位置不変。
      // forceTopRight は専用キャップ回避経路を持つため除外。描画限定・scorer/位置不変。
      if (allowGrazeLift && !placement.forceTopRight && pathPoints.length === 3) {
        const a = pathPoints[0];
        const b = pathPoints[1];
        const da = Math.hypot(a.x, a.y);
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const segMinR = distPointToSegment(0, 0, a.x, a.y, b.x, b.y);
        const onRim = Math.abs(da - cfg.pieRadius) < radialFraction(cfg, 0.02, 0.2);
        const grazing =
          segMinR >= intrudeR && segMinR < cfg.pieRadius + radialFraction(cfg, 0.02, 0.2);
        if (da > 1e-9 && segLen > 1e-9 && onRim && grazing) {
          const dotRadial = Math.abs(((b.x - a.x) * a.x + (b.y - a.y) * a.y) / (segLen * da));
          if (dotRadial < NEAR_TANGENT_DOT_RADIAL_MAX) {
            const thA = Math.atan2(a.y, a.x);
            const thE = Math.atan2(endpoint.y, endpoint.x);
            let dTh = thE - thA;
            while (dTh > Math.PI) dTh -= 2 * Math.PI;
            while (dTh < -Math.PI) dTh += 2 * Math.PI;
            if (Math.abs(dTh) < LEADER_MAX_ANGULAR_DIFF_RAD) {
              const rc = cfg.pieRadius + 2.5 * pxUnit; // 上の `intrudes` リルートと同値
              const midTh = thA + dTh / 2;
              const rw = rc / Math.cos(Math.abs(dTh) / 2);
              const w = { x: rw * Math.cos(midTh), y: rw * Math.sin(midTh) };
              // W テント先頭セグメント a→W が依然 rim をなぞる (anchor が rim 上だと a→W は二等分接線
              // ゆえ `rc` 不問で minR≈pieRadius に固定され、テントでは grazing が解消しない: 例
              // currency_many_small_10「イギリスポンド」) 場合は、2 点版 (line376) と同形の放射スタブへ
              // フォールバックする。anchor をスライス角範囲内でラベル端点角側へクランプした rim 点 `na`
              // から放射状に降ろし、円周なぞりを解消する。`tentLifts` (テントが実際に円縁から内側へ持ち
              // 上がった) ときのみ従来どおり W テントを採用する。
              const tentLifts =
                distPointToSegment(0, 0, a.x, a.y, w.x, w.y) <
                cfg.pieRadius - radialFraction(cfg, 0.02, 0.2);
              if (tentLifts) {
                const de = clampOutsidePie(
                  truncateLeaderEndpointAtBox(w, endpoint, finalBox, cfg.cornerGap),
                );
                pathPoints = [a, w, de];
                detectPathPoints = [a, w, endpoint]; // 持ち上げ後の到達域 (上の `intrudes` と同形)
              } else {
                // 放射スタブ (line409-429 と同形)。`detectPathPoints` は元 anchor 据え置きのまま
                // (交差判定・採点を baseline 維持)。`na` は放射的 (dotRadial>閾値) なので下の 2 点
                // tangent ハンドラ (line376) では非発火 = 二重クランプは起きない。
                const anchorAng = thA;
                const spanRad = ((placement.item.percent ?? 0) / 100) * 2 * Math.PI;
                const half = Math.max(
                  0,
                  spanRad / 2 - Math.min(spanRad * 0.15, (6 * Math.PI) / 180),
                );
                let rel = thE - anchorAng;
                while (rel > Math.PI) rel -= 2 * Math.PI;
                while (rel < -Math.PI) rel += 2 * Math.PI;
                const ang = anchorAng + Math.max(-half, Math.min(half, rel));
                const na = { x: cfg.pieRadius * Math.cos(ang), y: cfg.pieRadius * Math.sin(ang) };
                const de = clampOutsidePie(
                  truncateLeaderEndpointAtBox(na, endpoint, finalBox, cfg.cornerGap),
                );
                pathPoints = [na, de];
              }
            }
          }
        }
      }
      // 近接線 rim leader の持ち上げ: rim 縮退で 2 点直線になった leader が円周にほぼ接して
      // 視認しにくい (パイ縁に溶ける) ケースを、既存 W (二等分接線) リルートで小さなテントへ持ち
      // 上げる。上の `intrudes` ゲートは円を貫く leader だけを捕えるため dist≈pieRadius の非貫通
      // 近接線はすり抜ける。ここで anchor 半径方向と描画セグメント方向の内積で接線性を検出する。
      // 発火は (1) 2 点直線 (上記スタブ除去後の rim 縮退), (2) rim 上 anchor, (3) 近接線 の論理積に
      // 限る。forceTopRight は 3 点 L で length>2 のため除外、inside は外側 if で除外、放射 leader は
      // 内積で除外。スタブ除去の後に置き、生成した 3 点が再度 2 点へ畳まれないようにする。描画限定・scorer 不変。
      if (!placement.forceTopRight && pathPoints.length === 2) {
        const a = pathPoints[0];
        const e = pathPoints[1];
        const da = Math.hypot(a.x, a.y);
        const segLen = Math.hypot(e.x - a.x, e.y - a.y);
        const onRim = Math.abs(da - cfg.pieRadius) < radialFraction(cfg, 0.02, 0.2);
        if (da > 1e-9 && segLen > 1e-9 && onRim) {
          const dotRadial = Math.abs(((e.x - a.x) * a.x + (e.y - a.y) * a.y) / (segLen * da));
          if (dotRadial < NEAR_TANGENT_DOT_RADIAL_MAX) {
            const thA = Math.atan2(a.y, a.x);
            const thE = Math.atan2(endpoint.y, endpoint.x);
            let dTh = thE - thA;
            while (dTh > Math.PI) dTh -= 2 * Math.PI;
            while (dTh < -Math.PI) dTh += 2 * Math.PI;
            const rc = cfg.pieRadius + radialFraction(cfg, 0.04, 0.4); // 明確に見える持ち上げ
            const rw = rc / Math.cos(Math.abs(dTh) / 2);
            // テント頂点 W が描画上のラベル接続点 (`e` = box 縁で truncate 済) の半径を越えて飛び出すと、ラベルが rim 際にある
            // 短い leader では W が接続点を飛び越す「外向きの切り欠き」になり不自然 (例 stress_balanced_5 D)。
            // 飛び出しを小さく目立たない量 (≈4px) 以内に抑えられる = ラベルが rim から十分外にある時だけ持ち上げ、
            // それ以外 (rim 際) は下の else で放射化する。clamp で rw を下げると接線条件が崩れ
            // 円侵入し得るため、テント自体は下げずに非発火にする。
            const overshootTol = radialFraction(cfg, 0.02, 0.2);
            if (
              Math.abs(dTh) < LEADER_MAX_ANGULAR_DIFF_RAD &&
              Math.hypot(e.x, e.y) >= rw - overshootTol
            ) {
              const midTh = thA + dTh / 2;
              const w = { x: rw * Math.cos(midTh), y: rw * Math.sin(midTh) };
              const de = clampOutsidePie(
                truncateLeaderEndpointAtBox(w, endpoint, finalBox, cfg.cornerGap),
              );
              pathPoints = [a, w, de];
              detectPathPoints = [a, w, endpoint];
            } else {
              // 近 rim (テント不可) の接線 leader: 直線の接線弦を残すと弧をなぞって見にくい
              // (例 stress_balanced_5 D は dotRadial≈0.007 = ほぼ完全な接線)。anchor がスライス
              // 中心角に固定され、ラベル接続点が別角度で両方 rim 際にあるのが原因。描画 anchor を
              // ラベル角度 (スライス角度範囲 = `a` の角度 ±spanRad/2 内にクランプ) へ寄せ、放射状の
              // 短い leader にして弧なぞりを解消する。角度は実 anchor `a` の atan2 基準で算出し
              // midAngle の符号規約に依存しない (clamp 角=anchor 角のとき na≈a)。detectPathPoints は
              // 元 anchor 据え置きで交差判定・採点を baseline 維持。放射スタブは外向きで円侵入せず
              // 短く、元の接線弦の角度ウェッジ内なので新規交差を生まない。描画限定・scorer 不変。
              const anchorAng = Math.atan2(a.y, a.x);
              const spanRad = ((placement.item.percent ?? 0) / 100) * 2 * Math.PI;
              const half = Math.max(0, spanRad / 2 - Math.min(spanRad * 0.15, (6 * Math.PI) / 180));
              let rel = thE - anchorAng;
              while (rel > Math.PI) rel -= 2 * Math.PI;
              while (rel < -Math.PI) rel += 2 * Math.PI;
              const ang = anchorAng + Math.max(-half, Math.min(half, rel));
              const na = { x: cfg.pieRadius * Math.cos(ang), y: cfg.pieRadius * Math.sin(ang) };
              const de = clampOutsidePie(
                truncateLeaderEndpointAtBox(na, endpoint, finalBox, cfg.cornerGap),
              );
              pathPoints = [na, de];
            }
          }
        }
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
    if (Math.hypot(endpoint.x - a.x, endpoint.y - a.y) > dominantOutsideLeaderGap)
      skipLeader = false;
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
    const pieClear = cfg.pieRadius - pxToLogical(cfg, 2);
    for (let k = 0; k + 1 < pathPoints.length; k += 1) {
      if (
        distPointToSegment(
          0,
          0,
          pathPoints[k].x,
          pathPoints[k].y,
          pathPoints[k + 1].x,
          pathPoints[k + 1].y,
        ) < pieClear
      ) {
        skipLeader = true;
        break;
      }
    }
  }
  return { pathPoints, detectPathPoints, skipLeader };
}

/**
 * 上左 ([90°,135°]) の小スライスが引く「短い」leader か。短い = ラベルが自スライスのすぐ外側に
 * あり、線が無くても接続が自明 (例: REIT 国別の シンガポール 3.5%)。本判定は emit 最終段
 * (Pass 2.6) だけで使い、`computeDrawnLeader` / 採点には載せない。これにより leader 線を消すだけで
 * レイアウト選択や他 leader の交差解決には一切影響しない (ラベル位置は不変)。閾値 (≈0.5·R) で
 * 「その他」級の右逃がし leader (≈1.2·R) や遠方へ逃がした leader は残す。述語 (`isSmall` / `midAngle`>90 /
 * 帯内 / 非「その他」) は `layout/diagnostics.ts` の `markTopBandSmallRight` の候補条件と同系。
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
 * 短い = ラベルが自スライス外縁に隣接し線が無くても接続が自明 (例: アメリカ・ドル58%)。
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
export function resolveLeaderCrossings(
  pixPaths: (Pt[] | null)[],
  names: string[],
  skip: boolean[],
): void {
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

/** placement box の pixel 射影。`Coord` で y が反転しうるので min/max で辺を確定する。 */
export type PixelBox = { left: number; right: number; top: number; bottom: number };

/**
 * 1 回の採点で共有する leader 幾何。採点ベクトルが呼ぶ計数関数はどれも `realLeaderPaths`
 * (内部で `computeDrawnLeader` → `placementBox`) と `placementBox` を自前で作れるが、各関数に
 * 個別に作らせると採点 1 回につき同じ折れ線と box を 4 回以上作ることになる。ここで placements
 * 1 巡ぶんだけ計算し、`...From` / `...Of` 系の内部関数へ配る。
 * 値はどれも純関数の結果なので、1 回計算して配っても各関数が個別に計算しても同じ数値になる
 * (計算式と FP 演算の順序は各関数の中で不変)。
 */
export interface LeaderGeometry {
  /** 実描画 leader の pixel 折れ線 (skip は null)。`realLeaderPaths` と同じ。 */
  paths: (Pt[] | null)[];
  /** 各 placement の logical box。`placementBox` と同じ。 */
  boxes: BBox[];
  /** `boxes` の pixel 射影。`projectBoxesToPixels` と同じ。 */
  pixelBoxes: PixelBox[];
}

/** 1 回の採点で共有する leader 幾何 (折れ線・logical box・pixel box) をまとめて作る。 */
export function collectLeaderGeometry(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): LeaderGeometry {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = placements.map((p) => placementBox(p, cfg));
  return { paths, boxes, pixelBoxes: boxes.map((lb) => projectBoxToPixels(lb, coord)) };
}

/**
 * `geo` の index `i` だけを現在の placement から作り直した幾何 (元の `geo` は変更しない)。
 * bend 格子の候補ループのように 1 つの placement しか動かない場面で、他の leader と box を
 * 作り直さないために使う。差し替える値は `collectLeaderGeometry` と同じ式で作るので、全体を
 * 作り直した場合と同じ数値になる。動いていない placement が 1 つでもあると値が古くなるので、
 * 「i 以外は不変」が呼び出し側で保証できる場面にだけ使うこと。
 */
export function replaceLeaderGeometryAt(
  geo: LeaderGeometry,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  i: number,
): LeaderGeometry {
  const r = computeDrawnLeader(placements[i], cfg, false);
  const box = placementBox(placements[i], cfg);
  const paths = geo.paths.slice();
  const boxes = geo.boxes.slice();
  const pixelBoxes = geo.pixelBoxes.slice();
  paths[i] = r.skipLeader
    ? null
    : r.pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
  boxes[i] = box;
  pixelBoxes[i] = projectBoxToPixels(box, coord);
  return { paths, boxes, pixelBoxes };
}

/** logical box 1 つを pixel 空間の辺へ射影する。 */
function projectBoxToPixels(lb: BBox, coord: Coord): PixelBox {
  return {
    left: Math.min(coord.xScale(lb.left), coord.xScale(lb.right)),
    right: Math.max(coord.xScale(lb.left), coord.xScale(lb.right)),
    top: Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom)),
    bottom: Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom)),
  };
}

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
  if (cfg.perfCounters) cfg.perfCounters.realLeaderPaths += 1;
  return placements.map((p) => {
    const r = computeDrawnLeader(p, cfg, false);
    if (r.skipLeader) return null;
    return r.pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
  });
}

/**
 * 実描画 leader 同士が交差する **対の集合** (verify の "leader crossing" と同条件・pixel 空間)。
 * キーはスライス名の対 (辞書順) `"名A×名B"`。**インデックスでなく名前** を使うのは、レイアウトを
 * 作り直した別 placements 配列 (例 逃がし枚数違い) と集合を比較するため — 配列順は再生成で変わるが
 * スライス名は不変。合計だけでなく「どの対が交差しているか」を見たい do-no-harm で使う
 * (合計据え置きの局所入替 = ある交差を消して別の交差を作る、を検出するため)。
 */
export function leaderCrossingPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): Set<string> {
  return crossingPairsFrom(placements, realLeaderPaths(placements, cfg, coord));
}

/** `leaderCrossingPairs` の本体 (leader 折れ線を引数から受ける)。 */
function crossingPairsFrom(placements: Placement[], paths: (Pt[] | null)[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < paths.length; i += 1) {
    const pa = paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < paths.length; j += 1) {
      const pb = paths[j];
      if (!pb || !pathsCross(pa, pb)) continue;
      const [x, y] = [placements[i].item.name, placements[j].item.name].sort();
      pairs.add(`${x}×${y}`);
    }
  }
  return pairs;
}

/** 実描画 leader 同士が交差する対の数 (verify の "leader crossing" と同条件・pixel 空間)。 */
export function countLeaderCrossings(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return leaderCrossingPairs(placements, cfg, coord).size;
}

/** `countLeaderCrossings` の事前計算版 (`collectLeaderGeometry` の結果から数える)。 */
export function countLeaderCrossingsFrom(placements: Placement[], geo: LeaderGeometry): number {
  return crossingPairsFrom(placements, geo.paths).size;
}

/**
 * 実描画 leader が自分以外のラベル box を貫く **対の集合** (verify の "leader through label" と同条件・
 * pixel)。キーはスライス名の対 `"貫くleaderの名>貫かれるboxの名"` (向きがあるので辞書順にしない)。
 * `leaderCrossingPairs` と同じく **名前キー** で別 placements 配列と比較でき、合計据え置きの局所入替を
 * 検出する。
 */
export function leaderThroughPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): Set<string> {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = projectBoxesToPixels(placements, cfg, coord);
  return throughPairsFrom(placements, paths, boxes);
}

/** `leaderThroughPairs` の本体 (leader 折れ線と pixel box を引数から受ける)。 */
function throughPairsFrom(
  placements: Placement[],
  paths: (Pt[] | null)[],
  pixelBoxes: PixelBox[],
): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < paths.length; i += 1) {
    const pts = paths[i];
    if (!pts) continue;
    for (let j = 0; j < placements.length; j += 1) {
      if (j === i) continue;
      if (leaderCrossesBox(pts, pixelBoxes[j]))
        pairs.add(`${placements[i].item.name}>${placements[j].item.name}`);
    }
  }
  return pairs;
}

/** 実描画 leader が自分以外のラベル box を貫く件数 (verify の "leader through label" と同条件・pixel)。 */
export function countLeaderThroughLabels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return leaderThroughPairs(placements, cfg, coord).size;
}

/** `countLeaderThroughLabels` の事前計算版。 */
export function countLeaderThroughLabelsFrom(placements: Placement[], geo: LeaderGeometry): number {
  return throughPairsFrom(placements, geo.paths, geo.pixelBoxes).size;
}

/** 折れ線の全長 (logical)。leader の「短さ」を測るのに使う。 */
function pathLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i += 1) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

/**
 * 「rim に貼り付いた短い leader」か。rim 上のアンカーから **放射方向より接線方向に近い向き** へ短く
 * 伸びるだけで、線が円縁に溶けて由来スライスを指し示さない形を捉える。
 *
 * 判定は 3 つの論理積で、いずれもチャート寸法に対する相対量 (px 直値もスライス枚数も持たない):
 * (1) 始点が rim 上 (`|da − pieRadius|` が薄帯内) (2) 全長が短い (`dominantOutsideLeaderGap` 未満)
 * (3) 先頭セグメント方向と anchor 半径方向の |内積| が `SHORT_RIM_LEADER_DOT_RADIAL_MAX` 未満。
 * 健全な放射 leader は内積 ≈ 1 なので非発火。
 */
function isShortRimHuggingLeader(pathPoints: Pt[], cfg: PieLayoutConfig): boolean {
  if (pathPoints.length < 2) return false;
  const [a, b] = pathPoints;
  const da = Math.hypot(a.x, a.y);
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (da < 1e-9 || segLen < 1e-9) return false;
  if (Math.abs(da - cfg.pieRadius) >= radialFraction(cfg, 0.02, 0.2)) return false;
  if (pathLength(pathPoints) >= radialFraction(cfg, 0.3, 2.8)) return false;
  const dotRadial = Math.abs(((b.x - a.x) * a.x + (b.y - a.y) * a.y) / (segLen * da));
  return dotRadial < SHORT_RIM_LEADER_DOT_RADIAL_MAX;
}

/**
 * 「束になった rim 貼り付き短 leader」の本数。`isShortRimHuggingLeader` を満たす leader のうち、
 * 他の同型 leader と **先頭セグメント方向がほぼ平行** かつ **rim アンカーが円弧上で隣接** と言える
 * 距離にあるものを数える。
 *
 * 単独の短スタブは近くに紛らわしい線が無いので由来を取り違えようがない。読めなくなるのは平行な
 * 短線が並んだときだけなので、症状の定義をそのまま述語にしている。
 *
 * **`countDefects` には入れない**: 入れると候補選択 (その他 右/左・spread 等) が全チャートで動く。
 * `countLeaderThroughLabels` / `countAngularDiscordantPairs` と同じ「二級 defect = ゲートに明示的に
 * 足したパスだけが見る」立ち位置で使う。
 */
export function countBundledRimStubs(placements: Placement[], cfg: PieLayoutConfig): number {
  const stubs = placements.map((p) => {
    const r = computeDrawnLeader(p, cfg, false);
    if (r.skipLeader || !isShortRimHuggingLeader(r.pathPoints, cfg)) return null;
    const [a, b] = r.pathPoints;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { anchor: a, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
  });
  const maxAnchorGap = cfg.pieRadius * BUNDLED_RIM_STUB_MAX_ANCHOR_GAP_FACTOR;
  let bundledCount = 0;
  for (let i = 0; i < stubs.length; i += 1) {
    const s = stubs[i];
    if (!s) continue;
    const hasNeighbour = stubs.some((o, j) => {
      if (!o || i === j) return false;
      if (Math.hypot(o.anchor.x - s.anchor.x, o.anchor.y - s.anchor.y) > maxAnchorGap) return false;
      return s.dir.x * o.dir.x + s.dir.y * o.dir.y > BUNDLED_RIM_STUB_MIN_DIR_COS;
    });
    if (hasNeighbour) bundledCount += 1;
  }
  return bundledCount;
}

// -----------------------------------------------------------------------------
// 後処理 (角度順整列 / 各種 escape / 修復) の do-no-harm ゲートで共通に使う「不具合量」計測。
// これらはどの後処理関数でも「全 placement を横断し最大侵入/重なり/はみ出しを測る」純関数。
// -----------------------------------------------------------------------------

/** 全 placement 対の最大縦重なり量 (logical, X が重なる対のみ)。do-no-harm の ovl 指標。 */
export function boxOverlapMax(placements: Placement[], cfg: PieLayoutConfig): number {
  return boxOverlapMaxOf(placements.map((p) => placementBox(p, cfg)));
}

/** `boxOverlapMax` の box 配列版。対ごとに `placementBox` を作り直さない。 */
export function boxOverlapMaxOf(boxes: BBox[]): number {
  let m = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (ox > 0 && oy > 0) m = Math.max(m, oy);
    }
  }
  return m;
}

/** 円外ラベル box の pie 円 (中心=logical 原点) への最大侵入深さ (logical)。verify "label inside pie" のゲート。 */
export function boxPieIntrusionMax(placements: Placement[], cfg: PieLayoutConfig): number {
  return boxPieIntrusionMaxOf(
    placements,
    placements.map((p) => placementBox(p, cfg)),
    cfg,
  );
}

/** `boxPieIntrusionMax` の box 配列版 (`boxes[i]` は `placements[i]` の box)。 */
export function boxPieIntrusionMaxOf(
  placements: Placement[],
  boxes: BBox[],
  cfg: PieLayoutConfig,
): number {
  let m = 0;
  for (let i = 0; i < placements.length; i += 1) {
    if (placements[i].insideSlice) continue;
    const bx = boxes[i];
    const nx = Math.max(bx.left, Math.min(bx.right, 0));
    const ny = Math.max(bx.bottom, Math.min(bx.top, 0));
    m = Math.max(m, cfg.pieRadius - Math.hypot(nx, ny));
  }
  return m;
}

/** 1 つの placement box の viewBox はみ出し量 (pixel, 4 辺の最大。負=内側はそのまま負値)。 */
export function boxViewOverflowOf(p: Placement, cfg: PieLayoutConfig, coord: Coord): number {
  return boxViewOverflowOfBox(placementBox(p, cfg), coord);
}

/** `boxViewOverflowOf` の box 版。 */
export function boxViewOverflowOfBox(lb: BBox, coord: Coord): number {
  const left = Math.min(coord.xScale(lb.left), coord.xScale(lb.right));
  const right = Math.max(coord.xScale(lb.left), coord.xScale(lb.right));
  const top = Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom));
  const bottom = Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom));
  return Math.max(-left, right - coord.width, -top, bottom - coord.height);
}

/** 全 placement box の viewBox はみ出し量の最大 (pixel, 0 下限)。 */
export function boxViewOverflowMax(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return boxViewOverflowMaxOf(
    placements.map((p) => placementBox(p, cfg)),
    coord,
  );
}

/** `boxViewOverflowMax` の box 配列版。 */
export function boxViewOverflowMaxOf(boxes: BBox[], coord: Coord): number {
  let m = 0;
  for (const lb of boxes) m = Math.max(m, boxViewOverflowOfBox(lb, coord));
  return Math.max(0, m);
}

/** placement box を pixel 空間の {left,right,top,bottom} へ射影した配列 (leader×box 貫通判定の前処理)。 */
export function projectBoxesToPixels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): PixelBox[] {
  return placements.map((p) => projectBoxToPixels(placementBox(p, cfg), coord));
}

/** いずれかの点が viewBox を 1px 超はみ出す leader の本数 (do-no-harm の oob 指標)。 */
export function oobLeaderCount(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return oobLeaderCountFrom(realLeaderPaths(placements, cfg, coord), coord);
}

/** `oobLeaderCount` の path 配列版。 */
export function oobLeaderCountFrom(paths: (Pt[] | null)[], coord: Coord): number {
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

type AngularStack = { labelY: number; anchorY: number }[];

/** verify と同基準で各円外ラベルの {labelY, anchorY} (pixel) を左右スタックに分けて返す。 */
function angularStacks(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): { left: AngularStack; right: AngularStack } {
  return angularStacksFrom(
    placements,
    coord,
    realLeaderPaths(placements, cfg, coord),
    placements.map((p) => placementBox(p, cfg)),
  );
}

/**
 * `angularStacks` の本体 (leader 折れ線と box を引数から受ける)。除外対象の box も配列に
 * 含まれるが、その index を読まないので値には関与しない。
 */
function angularStacksFrom(
  placements: Placement[],
  coord: Coord,
  paths: (Pt[] | null)[],
  boxes: BBox[],
): { left: AngularStack; right: AngularStack } {
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const left: AngularStack = [];
  const right: AngularStack = [];
  placements.forEach((p, i) => {
    if (p.insideSlice) return;
    // 意図的に角度順を破る/固定する その他 のみ除外する: コア帯 (右上逃がし or 真上垂直) と
    // 左拡張帯 (常に真上垂直 center 固定。アンカー最上・ラベル天井固定で構造的に concordant)、
    // および forceTopRight。帯外 (>122°) で左右スタックに通常 rim 配置された その他 は順序
    // チェックに参加させる (除外すると下位スタックでの逆転が見逃される)。
    if (isOtherCategory(p.item.name) && (topBandSonohokaZone(p.item) !== null || p.forceTopRight)) {
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
    const box = boxes[i];
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
  return discordantPairsOf(angularStacks(placements, cfg, coord));
}

/** `countAngularDiscordantPairs` の事前計算版。 */
export function countAngularDiscordantPairsFrom(
  placements: Placement[],
  coord: Coord,
  geo: LeaderGeometry,
): number {
  return discordantPairsOf(angularStacksFrom(placements, coord, geo.paths, geo.boxes));
}

/** 左右スタックから discordant 対を数える (`countAngularDiscordantPairs` の本体)。 */
function discordantPairsOf(stacks: { left: AngularStack; right: AngularStack }): number {
  let dis = 0;
  for (const arr of [stacks.left, stacks.right]) {
    arr.sort((a, b) => a.labelY - b.labelY);
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        if (arr[j].anchorY < arr[i].anchorY - 2) dis += 1;
      }
    }
  }
  return dis;
}
