// =============================================================================
// redlineDiff.ts — 赤入れ表示の差分計算（純関数）
// =============================================================================
// 役割: 基準（確定版）と live（編集中）の平坦ツリーを整列し、キャンバスへ置く装飾の指示
// （`RedlineOp`）を返す。再帰の考え方は精査画面の `htmlBlockDiff.diffElement` と同じで、
// 同キーの要素対は降りる、片側にしか無いものは追加 / 削除、テキスト対は語句 LCS。
// DOM には触らず、live ノードの解決子だけを op に載せる（適用は `redlineApply.ts`）。

import type { ComponentDefinition } from 'grapesjs';
import {
  type DiffOp,
  diffTokens,
  type LcsBudget,
  tokenize,
} from '@/features/compare/htmlBlockDiff';
import type { NodeResolver, RedlineNode } from './redlineTree';

export type RedlineOp =
  | { kind: 'delText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'insText'; node: NodeResolver; ops: DiffOp[] }
  | { kind: 'addedEl'; node: NodeResolver }
  | {
      kind: 'removedEl';
      /** 挿入先の親（null = ルート）。 */
      parent: NodeResolver | null;
      /** この live ノードの直前へ挿す。null = 親の末尾。 */
      before: NodeResolver | null;
      /** 削除されたのがテキストなら inline、要素なら block。 */
      inline: boolean;
      def?: ComponentDefinition;
      text?: string;
    };

/** 空白の違いだけを差分にしない（`htmlBlockDiff.collapse` と同じ正規化）。 */
function collapse(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function diffText(b: RedlineNode, l: RedlineNode, budget: LcsBudget, out: RedlineOp[]): void {
  if (collapse(b.text) === collapse(l.text)) return;
  const { ops } = diffTokens(tokenize(b.text ?? ''), tokenize(l.text ?? ''), budget);
  if (ops.some((o) => o.type === 'del')) out.push({ kind: 'delText', node: l.node, ops });
  if (ops.some((o) => o.type === 'ins')) out.push({ kind: 'insText', node: l.node, ops });
}

function removedOp(
  b: RedlineNode,
  parent: NodeResolver | null,
  before: NodeResolver | null,
): RedlineOp {
  return b.kind === 'text'
    ? { kind: 'removedEl', parent, before, inline: true, text: b.text }
    : { kind: 'removedEl', parent, before, inline: false, def: b.def };
}

/** live にだけあるテキストは着色手段が無い（挿入語句として全文をハイライトする）。 */
function insertedTextOp(l: RedlineNode): RedlineOp {
  return { kind: 'insText', node: l.node, ops: [{ type: 'ins', text: l.text ?? '' }] };
}

/**
 * 基準側で `index` より後にある兄弟のうち、live にも存在する最初のものの live ノードを返す。
 * 削除要素は「基準でその直前にあった位置」へ置きたいので、次に残っている兄弟の前に挿す。
 */
function insertionPoint(
  base: RedlineNode[],
  index: number,
  liveByKey: Map<string, RedlineNode>,
): NodeResolver | null {
  for (let i = index + 1; i < base.length; i++) {
    const l = liveByKey.get(base[i].key);
    if (l) return l.node;
  }
  return null;
}

function diffChildren(
  base: RedlineNode[],
  live: RedlineNode[],
  parent: NodeResolver | null,
  budget: LcsBudget,
  out: RedlineOp[],
): void {
  const baseByKey = new Map(base.map((n) => [n.key, n]));
  const liveByKey = new Map(live.map((n) => [n.key, n]));

  for (const l of live) {
    const b = baseByKey.get(l.key);
    if (!b) {
      out.push(l.kind === 'el' ? { kind: 'addedEl', node: l.node } : insertedTextOp(l));
      continue;
    }
    if (b.kind === 'text' && l.kind === 'text') {
      diffText(b, l, budget, out);
    } else if (b.kind === 'el' && l.kind === 'el' && b.tag === l.tag) {
      diffChildren(b.children, l.children, l.node, budget, out);
    } else {
      // 同じスロットだが種別 / tag が違う → 削除 + 追加。追加側は live の種別で出し分ける
      // （live-only 分岐と同じ判断のため `insertedTextOp` を共有し、drift を防ぐ）。
      out.push(removedOp(b, parent, l.node));
      out.push(l.kind === 'el' ? { kind: 'addedEl', node: l.node } : insertedTextOp(l));
    }
  }

  base.forEach((b, i) => {
    if (liveByKey.has(b.key)) return;
    out.push(removedOp(b, parent, insertionPoint(base, i, liveByKey)));
  });
}

/** 基準と live の平坦ツリーを比べ、キャンバスへ置く装飾の指示列を返す。 */
export function diffRedline(
  base: RedlineNode[],
  live: RedlineNode[],
  budget: LcsBudget,
): RedlineOp[] {
  const out: RedlineOp[] = [];
  diffChildren(base, live, null, budget, out);
  return out;
}
