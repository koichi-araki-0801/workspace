// =============================================================================
// redlineTree.ts — 赤入れ表示のための平坦ツリーと 2 つのアダプタ
// =============================================================================
// 役割: 編集キャンバスの赤入れ（確定版からの変更箇所の表示）は、GrapesJS のモデル木（live）と
// `Parser.parseHtml(確定版 HTML)` の定義木（基準）を比べて計算する。DOM 同士で比べないのは、
// canvas の live 要素に GrapesJS が自動 `id` を必ず付けるため、id 優先の整列キー
// （`lib/blockKey`）が基準側と一致しないから。モデルの `attributes` には明示属性しか無く、
// 両者は同じパーサと `parse:html:root` の刈り取りを通るので、この層で形が揃う。
// ここは 2 つの木を同じ `RedlineNode` へ写すだけで、差分の判断は `redlineDiff.ts` が持つ。

import type { Component, ComponentDefinition } from 'grapesjs';
import { rawKeyFromParts } from '@/lib/blockKey';

/** live 側のノード解決子。基準側は常に null を返す。 */
export type NodeResolver = () => Node | null;

export interface RedlineNode {
  kind: 'el' | 'text';
  /** 兄弟内で一意な整列キー。要素は `rawKey#n`、テキストは `#text#n`。 */
  key: string;
  tag?: string;
  text?: string;
  children: RedlineNode[];
  /** live 側: canvas DOM 上の対応ノード（要素または Text）。基準側は null。 */
  node: NodeResolver;
  /** 基準側のみ: 削除要素をキャンバスへ描くための定義。 */
  def?: ComponentDefinition;
}

const NULL_NODE: NodeResolver = () => null;

/** 空白だけのテキストは整列にも差分にも使わない（`htmlBlockDiff.childUnits` と同じ）。 */
function isBlankText(s: string | undefined): boolean {
  return (s ?? '').trim() === '';
}

/** 同一親の子に、基底キーの出現順 `#n` を付けて一意化する（`htmlBlockDiff.keyedUnits` と同規則）。 */
function assignKeys(nodes: { base: string; node: Omit<RedlineNode, 'key'> }[]): RedlineNode[] {
  const seen = new Map<string, number>();
  return nodes.map(({ base, node }) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...node, key: `${base}#${n}` };
  });
}

/** 定義の `classes` は文字列配列だが、モデル由来では `{ name }` の配列になることもある。 */
function firstClassOf(classes: unknown): string | null {
  if (!Array.isArray(classes) || classes.length === 0) return null;
  const c = classes[0] as string | { name?: string };
  return typeof c === 'string' ? c : (c?.name ?? null);
}

function elKey(attrs: Record<string, unknown> | undefined, classes: unknown, tag: string): string {
  return rawKeyFromParts({
    partId: typeof attrs?.['data-part-id'] === 'string' ? (attrs['data-part-id'] as string) : null,
    id: typeof attrs?.id === 'string' ? (attrs.id as string) : null,
    firstClass: firstClassOf(classes),
    tag,
  });
}

// ── 1. 基準側: パーサの定義木 ────────────────────────────────────────────────

/** パーサは子テキスト 1 つを配列でなくオブジェクトで返す。どちらでも配列に揃える。 */
function childDefs(def: ComponentDefinition): ComponentDefinition[] {
  const c = def.components as ComponentDefinition | ComponentDefinition[] | string | undefined;
  if (c == null || typeof c === 'string') return [];
  return Array.isArray(c) ? c : [c];
}

function defToNode(
  def: ComponentDefinition,
): { base: string; node: Omit<RedlineNode, 'key'> } | null {
  if (def.type === 'textnode') {
    const text = typeof def.content === 'string' ? def.content : '';
    if (isBlankText(text)) return null;
    return { base: '#text', node: { kind: 'text', text, children: [], node: NULL_NODE } };
  }
  // `Omit<ComponentProperties,…> + 索引シグネチャ` の組で `||` 経由の絞り込みが `{}` に
  // 潰れる grapesjs 側の型の癖があるため、ここだけ明示キャストで本来の型に戻す。
  const tag = ((def.tagName as string | undefined) || 'div').toLowerCase();
  let kids = childDefs(def);
  // 子を持たず `content` だけの text 要素は、その content を 1 個のテキスト子として扱う。
  if (kids.length === 0 && typeof def.content === 'string' && def.content !== '') {
    kids = [{ type: 'textnode', content: def.content }];
  }
  return {
    base: elKey(def.attributes as Record<string, unknown> | undefined, def.classes, tag),
    node: { kind: 'el', tag, children: fromDefinitions(kids), node: NULL_NODE, def },
  };
}

/** `Parser.parseHtml(html).html` の定義列を平坦ツリーへ写す。 */
export function fromDefinitions(
  defs: ComponentDefinition | ComponentDefinition[] | undefined,
): RedlineNode[] {
  if (!defs) return [];
  const list = Array.isArray(defs) ? defs : [defs];
  const out: { base: string; node: Omit<RedlineNode, 'key'> }[] = [];
  for (const d of list) {
    const n = defToNode(d);
    if (n) out.push(n);
  }
  return assignKeys(out);
}

// ── 2. live 側: GrapesJS のモデル木 ───────────────────────────────────────────

function compChildren(comp: Component): Component[] {
  const coll = comp.components();
  return coll.map((c: Component) => c);
}

function compToNode(comp: Component): { base: string; node: Omit<RedlineNode, 'key'> } | null {
  const type = String(comp.get('type') ?? '');
  if (type === 'textnode') {
    const text = String(comp.get('content') ?? '');
    if (isBlankText(text)) return null;
    return {
      base: '#text',
      node: { kind: 'text', text, children: [], node: () => comp.getEl() ?? null },
    };
  }
  const tag = String(comp.get('tagName') || 'div').toLowerCase();
  const kids = compChildren(comp);
  let children: RedlineNode[];
  const content = comp.get('content');
  if (kids.length === 0 && typeof content === 'string' && content !== '' && !isBlankText(content)) {
    // 子 Component を持たず `content` だけの text。DOM では要素の最初の子 Text がその本文。
    children = assignKeys([
      {
        base: '#text',
        node: {
          kind: 'text',
          text: content,
          children: [],
          node: () => {
            const first = comp.getEl()?.firstChild ?? null;
            return first && first.nodeType === Node.TEXT_NODE ? first : null;
          },
        },
      },
    ]);
  } else {
    children = fromComponents(comp);
  }
  return {
    base: elKey(
      comp.get('attributes') as Record<string, unknown> | undefined,
      comp.getClasses(),
      tag,
    ),
    node: { kind: 'el', tag, children, node: () => comp.getEl() ?? null },
  };
}

/** `root`（wrapper など）の子 Component 列を平坦ツリーへ写す。 */
export function fromComponents(root: Component): RedlineNode[] {
  const out: { base: string; node: Omit<RedlineNode, 'key'> }[] = [];
  for (const c of compChildren(root)) {
    const n = compToNode(c);
    if (n) out.push(n);
  }
  return assignKeys(out);
}

// ── 3. 削除要素の描画 ─────────────────────────────────────────────────────────

/** 写さない属性: 重複 id を作る `id`、実行を伴う `on*`、GrapesJS の内部指示 `data-gjs-*`。 */
function isRenderableAttr(name: string): boolean {
  const n = name.toLowerCase();
  return n !== 'id' && n !== 'contenteditable' && !n.startsWith('on') && !n.startsWith('data-gjs-');
}

/**
 * 基準側の定義から表示用 DOM を組む。文字列連結や `innerHTML` を使わず `createElement` /
 * `setAttribute` / `createTextNode` で組むので、本文や属性値に HTML の字面が入っていても
 * 文字列のまま出る（削除要素の中身は他ユーザが書いた本文である）。
 */
export function renderDefinition(def: ComponentDefinition, doc: Document): Node {
  if (def.type === 'textnode')
    return doc.createTextNode(typeof def.content === 'string' ? def.content : '');
  // 同上の grapesjs 型の癖を避けるための明示キャスト。
  const el = doc.createElement(((def.tagName as string | undefined) || 'div').toLowerCase());
  const attrs = (def.attributes ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(attrs)) {
    if (!isRenderableAttr(k) || v == null || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  const classes = Array.isArray(def.classes)
    ? (def.classes as (string | { name?: string })[]).map((c) =>
        typeof c === 'string' ? c : (c?.name ?? ''),
      )
    : [];
  const cls = classes.filter(Boolean).join(' ');
  if (cls) el.setAttribute('class', cls);
  let kids = childDefs(def);
  if (kids.length === 0 && typeof def.content === 'string' && def.content !== '') {
    kids = [{ type: 'textnode', content: def.content }];
  }
  for (const k of kids) el.appendChild(renderDefinition(k, doc));
  return el;
}
