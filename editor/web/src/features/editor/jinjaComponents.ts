// =============================================================================
// jinjaComponents.ts — locked な Jinja chip の GrapesJS component type 登録
// =============================================================================
// 役割: Jinja 構文を canvas 上でロックされた chip として扱うため、専用の
// `Component` type を GrapesJS に登録し、chip 表示用の canvas CSS も提供する。

import type { Editor } from 'grapesjs';

import { DATA_JINJA_OPEN } from '@/lib/jinjaAttrs';

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
  // mask した opaque content(`fillJinja` の `maskOpaque` が生成)。他の jinja chip と
  // 同様 locked にして GrapesJS に逐語保存させる。source は data-opaque にあり、保存時に
  // `jinjaMask` の `toTemplate` が復元する。
  // jinja-script: <script>。jinja-math: MathJax(TeX)と MathML の <math>。
  'jinja-script': { name: 'スクリプト', draggable: true, removable: true, copyable: false },
  'jinja-math': { name: '数式', draggable: true, removable: true, copyable: false },
};

/**
 * locked な Jinja chip の `Component` type 群を登録する。chip は `toEditable` が
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
    dc.addType(type, { model: { defaults: { ...common, ...JINJA_TYPE_DEFAULTS[type] } } });
  }
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
[${DATA_JINJA_OPEN}] { outline: 1px dashed #f59e0b; outline-offset: 2px; }
`;
