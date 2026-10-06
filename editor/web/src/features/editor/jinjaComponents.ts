// =============================================================================
// jinjaComponents.ts — locked な Jinja chip の GrapesJS component type 登録
// =============================================================================
// 役割: Jinja 構文を canvas 上でロックされた chip として扱うため、専用の
// `Component` type を GrapesJS に登録し、chip 表示用の canvas CSS も提供する。

import type { Component, Editor } from 'grapesjs';

/**
 * canvas で通用する `data-gjs-type` の全集合。**`addType` する型と、canvas 入口の
 * 刈り取り(`pruneCanvasActiveContent`)が通す型を同一の配列由来にする**ための正典で、
 * 型を足したときに片方だけ更新される事故を構造的に消す。
 *
 * `data-gjs-type` は GrapesJS の prop チャネルの一員だが、これだけは通す必要がある —
 * Jinja chip の型指定そのものであり、落とすと chip が汎用 component へ落ちて
 * `editable:false` が効かず、RTE が `data-jinja` 付き span を分解して `toTemplate` の
 * 復元が壊れる(= 編集 2 系統の round-trip が壊れる)。
 */
export const JINJA_COMPONENT_TYPES = [
  'jinja-var',
  'jinja-stmt',
  'jinja-comment',
  'jinja-script',
  'jinja-math',
  'jinja-rawtext',
  'jinja-frozen',
  'jinja-frozen-svg',
] as const;

export type JinjaComponentType = (typeof JINJA_COMPONENT_TYPES)[number];

/** `pruneCanvasActiveContent` の `allowedGjsTypes` へ渡す照合用 Set。 */
export const JINJA_COMPONENT_TYPE_SET: ReadonlySet<string> = new Set(JINJA_COMPONENT_TYPES);

/** 型ごとの表示名と操作可否。`common` と合成して `addType` へ渡す。 */
const JINJA_TYPE_DEFAULTS: Record<
  JinjaComponentType,
  { name: string; draggable: boolean; removable: boolean; copyable?: boolean }
> = {
  'jinja-var': { name: '差し込み（値）', draggable: true, removable: true },
  'jinja-stmt': { name: '条件・繰り返し', draggable: false, removable: false, copyable: false },
  'jinja-comment': { name: 'メモ', draggable: true, removable: true },
  // 原文を `data-opaque` に運ぶ部品(`fillJinja` が生成)。他の jinja chip と同様 locked にして
  // GrapesJS に逐語保存させ、保存時に `jinjaMask` の `toTemplate` が原文へ戻す。
  // jinja-script: <script>。jinja-math: MathJax(TeX)と MathML の <math>。
  // jinja-rawtext: 中に Jinja を含む <style> / <textarea> / <title> のラベル表示。
  'jinja-script': { name: 'スクリプト', draggable: true, removable: true, copyable: false },
  'jinja-math': { name: '数式', draggable: true, removable: true, copyable: false },
  'jinja-rawtext': {
    name: '埋め込み（CSS 等）',
    draggable: true,
    removable: true,
    copyable: false,
  },
  // 値入りの見た目のまま固めた要素(表・SVG・本文全体)。部品ごと動かす・消すことだけ許す。
  'jinja-frozen': { name: '編集不可（Jinja）', draggable: true, removable: true, copyable: false },
  'jinja-frozen-svg': {
    name: '編集不可（Jinja）',
    draggable: true,
    removable: true,
    copyable: false,
  },
};

/** 固めた要素の子孫へ配る操作可否。部品自身ではなく子孫だけを止める。 */
const LOCKED_DESCENDANT = {
  selectable: false,
  hoverable: false,
  editable: false,
  droppable: false,
  draggable: false,
  removable: false,
  copyable: false,
  stylable: false,
} as const;

/**
 * 固めた要素の子孫をすべて選べず編集もできないようにする。子孫にスタイルを当てられると
 * GrapesJS が自動 id と `#id` 規則を作り、保存で要素が原文へ戻ったあと規則だけが CSS に残る。
 * GrapesJS の `propagate` は部品自身の値を子孫へ写す仕組みで、部品自身を選べるまま子孫だけを
 * 止められないので、`init` で子孫へ直接設定する。
 */
function lockDescendants(c: Component): void {
  c.components().forEach((ch: Component) => {
    ch.set(LOCKED_DESCENDANT);
    lockDescendants(ch);
  });
}

const FROZEN_TYPES: ReadonlySet<JinjaComponentType> = new Set(['jinja-frozen', 'jinja-frozen-svg']);

/**
 * locked な Jinja chip の `Component` type 群を登録する。chip は `toFilled`(`fillJinja.ts`)が
 * `<span data-gjs-type="jinja-var|stmt|comment" data-jinja="…">` として生成する。
 * GrapesJS は `data-gjs-type` から type を自動割当する。ここでは非編集にし、
 * `data-jinja` source 属性を保持させ、ラベルを付ける。
 */
export function registerJinjaComponents(editor: Editor): void {
  const dc = editor.DomComponents;

  const common = {
    editable: false,
    droppable: false,
    badgable: true,
    highlightable: true,
    // data-jinja source 属性を編集/export を通して保持する
    attributes: {},
  };

  for (const type of JINJA_COMPONENT_TYPES) {
    if (FROZEN_TYPES.has(type)) continue;
    dc.addType(type, { model: { defaults: { ...common, ...JINJA_TYPE_DEFAULTS[type] } } });
  }

  const frozenModel = (type: JinjaComponentType) => ({
    defaults: { ...common, ...JINJA_TYPE_DEFAULTS[type], stylable: false },
    init(this: Component) {
      lockDescendants(this);
    },
  });
  dc.addType('jinja-frozen', { model: frozenModel('jinja-frozen') });
  // `svg` 型を継がないと子孫が SVG の名前空間で描かれない。`svg` 型の `getName` はタグ名を返して
  // `name` を見ないので、レイヤー名を他の固めた要素と揃えるために戻す。
  dc.addType('jinja-frozen-svg', {
    extend: 'svg',
    model: {
      ...frozenModel('jinja-frozen-svg'),
      getName(this: Component): string {
        return this.get('custom-name') || this.get('name');
      },
    },
  });
}

/** locked な Jinja chip を可視化するため GrapesJS canvas へ注入する CSS。 */
export const jinjaChipCanvasCss = `
.jinja-chip {
  display: inline-block;
  padding: 0 4px;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
/* 差し込み（値）チップ。字形・行送りを地の本文と揃えるため inline + 各 inherit +
   white-space:normal を維持し、チップの青箱（枠/monospace/縮小フォント）は打ち消す。
   これは「値が普通の本文として見える」素体で、両系統（編集/作成）で常に効かせる。
   data-jinja は CSS 非依存なので選択も toTemplate 復元も不変。 */
.jinja-chip.jinja-var {
  display: inline;
  padding: 0;
  border: 0;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}
/* 差し込み値ハイライト（薄い琥珀）は 設計正典.md「編集 2 系統」に従い、作成経路
   （テンプレ作成タブ＝共通sample・表示のみ）だけに出す。canvas body へ jinja-vars-highlight
   クラスが付いたときのみ可視化し、編集経路（実値編集）では出さない（setVarsHighlight が
   出し分ける）。背景は canvas のみ（プレビュー/PDF/保存出力には載らない）。
   注意: 素の .jinja-chip.jinja-var に background を直書きしないこと（編集タブへ漏れる）。 */
.jinja-vars-highlight .jinja-chip.jinja-var {
  padding: 0 1px;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.16);
  /* 値が行末で折り返しても各行に背景を出す。 */
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.jinja-chip.jinja-stmt { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
.jinja-chip.jinja-comment { background: #e5e7eb; color: #6b7280; border: 1px dashed #9ca3af; }
.jinja-chip.jinja-script { background: #ede9fe; color: #5b21b6; border: 1px solid #c4b5fd; }
.jinja-chip.jinja-math { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
.jinja-chip.jinja-rawtext { background: #e0f2fe; color: #075985; border: 1px solid #7dd3fc; }
/* ループの行と固めた要素の枠は作成タブ(canvas body に jinja-vars-highlight)だけに出す。素の
   .jinja-chip.jinja-var に背景を書かないのと同じ原則で、編集タブへ漏らさない。 */
.jinja-vars-highlight [data-jinja-loop-row] { outline: 1px dashed #f59e0b; outline-offset: 2px; }
.jinja-vars-highlight [data-opaque-kind="frozen"],
.jinja-vars-highlight .jinja-frozen-body > * { outline: 1px dashed #9ca3af; outline-offset: 2px; }
/* 見た目ではなく、本文全体を包んだ div でレイアウトを変えないための規則なのでスコープを付けない。 */
.jinja-frozen-body { display: contents; }
`;
