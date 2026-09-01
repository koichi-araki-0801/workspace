// =============================================================================
// noteBubbleLayout.ts — メモ吹き出しの配置計算(純関数)
// =============================================================================
// 役割: 選択パーツ・ページ・canvas コンテナ・吹き出しの寸法から、吹き出しを出す側と
// 座標・リーダー線を決める。DOM も Vue も触らない純関数なので、分岐(左右・重ね・縦
// クランプ)を単体テストで固定できる。座標系は overlay 層(canvas コンテナ相対、
// `getElementPos({noScroll:true})` と同じ)。
//
// ⚠ ページの大きさ・倍率はここでは決めない。吹き出しの都合で本体の見えを変えないのが
// 前提で、足りないときは重ねる(`overlap`)。

/** 配置計算の入力(すべて overlay 層の px)。 */
export interface BubbleAnchorInput {
  /** 選択パーツの矩形。 */
  part: { left: number; top: number; width: number; height: number };
  /** ページ(帳票)の水平位置と幅。 */
  page: { left: number; width: number };
  /** canvas コンテナの内寸。 */
  container: { width: number; height: number };
  /** 吹き出しの実寸(描画後に測った値)。 */
  bubble: { width: number; height: number };
}

/** 配置計算の結果。 */
export interface BubbleAnchor {
  /** 吹き出しを出す側。ページはこの反対側へ寄せる。 */
  side: 'left' | 'right';
  /** 寄せても幅が足りず、ページに重ねる必要があるか。 */
  overlap: boolean;
  left: number;
  top: number;
  /** パーツと吹き出しを結ぶ水平線(重ねる場合は幅 0)。 */
  leader: { left: number; top: number; width: number };
}

/** 吹き出しとコンテナ端の間に残す余白。 */
const EDGE_GAP = 12;
/** パーツと吹き出しの間隔(リーダー線の長さ)。 */
const LEADER_GAP = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 吹き出しの配置を決める。
 *
 * 左右は「リーダー線が帳票の上を横切る量が少ない側」で選ぶ。パーツ右端からページ右端まで
 * (`gapRight`)と、ページ左端からパーツ左端まで(`gapLeft`)を比べ、同値なら右へ出す
 * (ページ幅いっぱいのパーツは常にこの経路。実運用のパーツはほぼこれに当たる)。
 *
 * 場所は「吹き出しと反対側へページを寄せる」ことで作るので、判定に使う空きはページを
 * 端まで寄せたときの最大値 = `container.width - page.width` になる。これが吹き出しの幅に
 * 満たないときだけ `overlap` を立てる。
 */
export function computeBubbleAnchor(input: BubbleAnchorInput): BubbleAnchor {
  const { part, page, container, bubble } = input;
  const pageRight = page.left + page.width;
  const partRight = part.left + part.width;
  const side: 'left' | 'right' = pageRight - partRight <= part.left - page.left ? 'right' : 'left';

  // ページを端まで寄せたときに空く幅。ページは縮めないので、これが上限。
  const room = container.width - page.width;
  const overlap = room < bubble.width + EDGE_GAP;

  const top = clamp(
    part.top,
    EDGE_GAP,
    Math.max(EDGE_GAP, container.height - bubble.height - EDGE_GAP),
  );
  const centerY = part.top + part.height / 2;

  if (overlap) {
    // 重ねるときはパーツの内側へ寄せて置き、リーダーは引かない(距離が無く意味を持たない)。
    const left = clamp(
      side === 'right' ? partRight - bubble.width : part.left,
      EDGE_GAP,
      Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
    );
    return { side, overlap, left, top, leader: { left, top: centerY, width: 0 } };
  }

  if (side === 'right') {
    const left = clamp(
      partRight + LEADER_GAP,
      EDGE_GAP,
      Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
    );
    return {
      side,
      overlap,
      left,
      top,
      leader: { left: partRight, top: centerY, width: Math.max(0, left - partRight) },
    };
  }

  const left = clamp(
    part.left - LEADER_GAP - bubble.width,
    EDGE_GAP,
    Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
  );
  return {
    side,
    overlap,
    left,
    top,
    leader: {
      left: left + bubble.width,
      top: centerY,
      width: Math.max(0, part.left - (left + bubble.width)),
    },
  };
}

/**
 * 2 つの `BubbleAnchor`(null も可)が値として等しいか判定する。
 *
 * `computeBubbleAnchor` は呼ばれるたびに新しいオブジェクトを返すため、中身が同じでも
 * 参照だけが変わる。呼び出し側(`useCanvasMarkers.refreshBubbleAnchor`)がこの関数で
 * 「本当に変わったときだけ ref へ代入する」を保証しないと、Vue の変更検知(`Object.is`)は
 * 参照差だけで「変わった」と判定し、それを見ている watcher(位置の再計測 → 再代入)が
 * 自己再発火して無限ループになる(吹き出し表示中ずっと毎フレーム再計測が走る形)。
 */
export function sameBubbleAnchor(a: BubbleAnchor | null, b: BubbleAnchor | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.side === b.side &&
    a.overlap === b.overlap &&
    a.left === b.left &&
    a.top === b.top &&
    a.leader.left === b.leader.left &&
    a.leader.top === b.leader.top &&
    a.leader.width === b.leader.width
  );
}
