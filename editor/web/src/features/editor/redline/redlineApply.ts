// =============================================================================
// redlineApply.ts — 赤入れ装飾の生 DOM への適用と除去
// =============================================================================
// 役割: `redlineDiff` の指示列を canvas iframe の DOM に反映する。装飾は **生 DOM だけ**に置き、
// GrapesJS のモデルには載せない（`getHtml()` はモデルから再生成するため draft に混入しない。
// ページ表示マーカー `PV_ATTR` と同じ方針）。除去は完全復元が要件で、削除語句のために分割した
// Text ノードは `normalize()` で結合し直す。`normalize()` は先頭ノードを残して後続を吸収する
// ので、GrapesJS の textnode view が持つ先頭 Text への参照は生きたままになる。

import type { RedlineOp } from './redlineDiff';
import { renderDefinition } from './redlineTree';

export const REDLINE_ATTR = 'data-redline';
export const REDLINE_ADDED_ATTR = 'data-redline-added';
export const REDLINE_BLOCK_CLASS = 'redline-block';
/** CSS Custom Highlight API の登録名（挿入語句の着色。DOM を変えない）。 */
export const REDLINE_HIGHLIGHT = 'redline-ins';

type HighlightCtor = new () => { add(range: Range): void };
interface HighlightWindow {
  Highlight?: HighlightCtor;
  CSS?: { highlights?: Map<string, unknown> };
}

function isText(n: Node | null): n is Text {
  return !!n && n.nodeType === Node.TEXT_NODE;
}

function makeDel(doc: Document, inline: boolean): HTMLElement {
  const del = doc.createElement('del');
  del.setAttribute(REDLINE_ATTR, '');
  // RTE の contenteditable 領域の中に入っても編集対象にならないようにする。
  del.setAttribute('contenteditable', 'false');
  if (!inline) del.classList.add(REDLINE_BLOCK_CLASS);
  return del;
}

/** `same` / `ins` の文字数で進み、`del` の位置に旧語句を割り込ませる。 */
function applyDelText(text: Text, ops: RedlineOp & { kind: 'delText' }): void {
  const doc = text.ownerDocument;
  let cur = text;
  let offset = 0;
  let pendingDel = '';
  const flush = () => {
    if (!pendingDel) return;
    const del = makeDel(doc, true);
    del.textContent = pendingDel;
    pendingDel = '';
    const parent = cur.parentNode;
    if (!parent) return;
    if (offset === 0) {
      parent.insertBefore(del, cur);
    } else if (offset >= cur.data.length) {
      parent.insertBefore(del, cur.nextSibling);
    } else {
      const rest = cur.splitText(offset);
      parent.insertBefore(del, rest);
      cur = rest;
      offset = 0;
    }
  };
  for (const op of ops.ops) {
    if (op.type === 'del') {
      pendingDel += op.text;
      continue;
    }
    flush();
    offset += op.text.length;
  }
  flush();
}

/** 挿入語句の Range を CSS Highlight として登録する。API が無い環境では何もしない。 */
function applyInsText(
  text: Text,
  ops: RedlineOp & { kind: 'insText' },
  highlight: { add(r: Range): void } | null,
): void {
  if (!highlight) return;
  const doc = text.ownerDocument;
  let offset = 0;
  for (const op of ops.ops) {
    if (op.type === 'del') continue;
    if (op.type === 'ins') {
      const end = Math.min(offset + op.text.length, text.data.length);
      if (end > offset) {
        const r = doc.createRange();
        r.setStart(text, offset);
        r.setEnd(text, end);
        highlight.add(r);
      }
    }
    offset += op.text.length;
  }
}

function highlightRegistry(
  doc: Document,
): { ctor: HighlightCtor; registry: Map<string, unknown> } | null {
  const win = doc.defaultView as unknown as HighlightWindow | null;
  const ctor = win?.Highlight;
  const registry = win?.CSS?.highlights;
  return ctor && registry ? { ctor, registry } : null;
}

/**
 * 装飾を適用する。順序: `insText`（Range 登録）→ `delText`（Text 分割）→ 要素系。Range は
 * `splitText` に追従して境界を更新するが、分割前に登録する方が読みやすく検証もしやすい。
 */
export function applyRedline(rootEl: HTMLElement, ops: RedlineOp[]): void {
  const doc = rootEl.ownerDocument;
  const hl = highlightRegistry(doc);
  const highlight = hl ? new hl.ctor() : null;

  for (const op of ops) {
    if (op.kind !== 'insText') continue;
    const n = op.node();
    if (isText(n)) applyInsText(n, op, highlight);
  }
  if (hl && highlight) hl.registry.set(REDLINE_HIGHLIGHT, highlight);

  for (const op of ops) {
    if (op.kind !== 'delText') continue;
    const n = op.node();
    if (isText(n)) applyDelText(n, op);
  }

  for (const op of ops) {
    if (op.kind === 'addedEl') {
      const n = op.node();
      if (n instanceof Element) n.setAttribute(REDLINE_ADDED_ATTR, '');
    } else if (op.kind === 'removedEl') {
      const parent = op.parent ? op.parent() : rootEl;
      if (!(parent instanceof Element)) continue;
      const del = makeDel(doc, op.inline);
      if (op.inline) del.textContent = op.text ?? '';
      else if (op.def) del.appendChild(renderDefinition(op.def, doc));
      const before = op.before ? op.before() : null;
      parent.insertBefore(del, before && before.parentNode === parent ? before : null);
    }
  }
}

/** `scope` 配下の装飾を全て外し、分割した Text を結合して元の DOM に戻す。 */
function clearWithin(scope: HTMLElement, dropHighlight: boolean): void {
  const parents = new Set<Node>();
  for (const del of Array.from(scope.querySelectorAll(`[${REDLINE_ATTR}]`))) {
    if (del.parentNode) parents.add(del.parentNode);
    del.remove();
  }
  for (const el of Array.from(scope.querySelectorAll(`[${REDLINE_ADDED_ATTR}]`))) {
    el.removeAttribute(REDLINE_ADDED_ATTR);
  }
  scope.removeAttribute(REDLINE_ADDED_ATTR);
  for (const p of parents) p.normalize();
  if (dropHighlight) highlightRegistry(scope.ownerDocument)?.registry.delete(REDLINE_HIGHLIGHT);
}

export function clearRedline(rootEl: HTMLElement): void {
  clearWithin(rootEl, true);
}

/**
 * 指定要素の配下だけ装飾を外す（選択パーツ用）。挿入語句のハイライトは Range が要素を跨がず
 * 表示だけの存在なので残す（RTE の再取込に関与しない）。
 */
export function clearRedlineWithin(el: HTMLElement): void {
  clearWithin(el, false);
}
