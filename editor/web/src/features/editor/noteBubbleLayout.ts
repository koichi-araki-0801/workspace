// =============================================================================
// noteBubbleLayout.ts — メモ吹き出しの配置計算(純関数)
// =============================================================================
// 役割: 選択パーツ・ページ・canvas コンテナ・吹き出しの寸法から、吹き出しを出す側と座標を
// 決める。DOM も Vue も触らない純関数なので、分岐(左右・縦クランプ)を単体テストで固定できる。
// 座標系は overlay 層(canvas コンテナ相対、`getElementPos({noScroll:true})` と同じ)。
//
// 吹き出しは常にページへ重ねて出す(表計算ソフトのセルコメントと同じ挙動)。左右どちらへ
// 出すかだけをパーツの位置から選び、場所を空ける処理は持たない。
//
// ⚠ かつては吹き出しと反対側へページを寄せて場所を作る設計だったが、実機確認で原理的に
// 効かないと判明し廃止した(却下理由は `docs/editor/src/設計正典.md` の却下済み設計を見よ)。
// 要点: `.gjs-frame-wrapper`(ページ)は `width: 210mm !important`(= 794px)固定で、zoom は
// `transform: scale()` で掛かる。つまりレイアウト上の占有幅は表示倍率に関わらず常に 794px で、
// canvas コンテナ幅(~856px)との差である「寄せて空けられる余白」も常に ~62px しか無い
// (中央寄せの margin を 0 にしても、動くのはその半分の ~31px)。一方で場所の判定は
// `getElementPos` が返す**視覚幅**(倍率で縮んだ後の幅。例: 67% 表示なら 531px)で行っていた
// ため、判定は「余白は十分」と誤って結論し、実際には吹き出しがページへ重なって描画される
// 乖離が生じていた。ページの大きさ・倍率を変えずに余白を作る方法は無いので、常に重ねる方式へ
// 単純化した。

/** 配置計算の入力(すべて overlay 層の px)。 */
export interface BubbleAnchorInput {
  /** 選択パーツの矩形。 */
  part: { left: number; top: number; width: number; height: number };
  /** ページ(帳票)の水平位置と幅。吹き出しをどちら側へ出すかの判定にのみ使う。 */
  page: { left: number; width: number };
  /** canvas コンテナの内寸。 */
  container: { width: number; height: number };
  /** 吹き出しの実寸(描画後に測った値)。 */
  bubble: { width: number; height: number };
}

/** 配置計算の結果。吹き出しは常にページへ重ねて置く。 */
export interface BubbleAnchor {
  /** 吹き出しを出す側。 */
  side: 'left' | 'right';
  left: number;
  top: number;
}

/** 吹き出しとコンテナ端の間に残す余白。 */
const EDGE_GAP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 吹き出しの配置を決める。
 *
 * 左右は「吹き出しが帳票の上に重なる量が少ない側」で選ぶ。パーツ右端からページ右端まで
 * (`gapRight`)と、ページ左端からパーツ左端まで(`gapLeft`)を比べ、同値なら右へ出す
 * (ページ幅いっぱいのパーツは常にこの経路。実運用のパーツはほぼこれに当たる)。
 *
 * 位置はパーツの内側へ寄せて置く(右なら吹き出しの右端をパーツ右端に、左なら吹き出しの左端を
 * パーツ左端に合わせる)。縦はパーツ上端に合わせ、上下ともコンテナ内へクランプする。
 */
export function computeBubbleAnchor(input: BubbleAnchorInput): BubbleAnchor {
  const { part, page, container, bubble } = input;
  const pageRight = page.left + page.width;
  const partRight = part.left + part.width;
  const side: 'left' | 'right' = pageRight - partRight <= part.left - page.left ? 'right' : 'left';

  const top = clamp(
    part.top,
    EDGE_GAP,
    Math.max(EDGE_GAP, container.height - bubble.height - EDGE_GAP),
  );

  const left = clamp(
    side === 'right' ? partRight - bubble.width : part.left,
    EDGE_GAP,
    Math.max(EDGE_GAP, container.width - bubble.width - EDGE_GAP),
  );

  return { side, left, top };
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
  return a.side === b.side && a.left === b.left && a.top === b.top;
}
