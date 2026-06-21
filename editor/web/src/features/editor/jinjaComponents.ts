// =============================================================================
// jinjaComponents.ts — locked な Jinja chip の GrapesJS component type 登録
// =============================================================================
// 役割: Jinja 構文を canvas 上でロックされた chip として扱うため、専用の
// `Component` type を GrapesJS に登録し、chip 表示用の canvas CSS も提供する。

import type { Editor } from 'grapesjs';

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

  dc.addType('jinja-var', {
    model: {
      defaults: {
        ...common,
        name: '差し込み（値）',
        draggable: true,
        removable: true,
      },
    },
  });

  dc.addType('jinja-stmt', {
    model: {
      defaults: {
        ...common,
        name: '条件・繰り返し',
        draggable: false,
        removable: false,
        copyable: false,
      },
    },
  });

  dc.addType('jinja-comment', {
    model: {
      defaults: {
        ...common,
        name: 'メモ',
        draggable: true,
        removable: true,
      },
    },
  });

  // mask した opaque content(`fillJinja` の `maskOpaque` が生成)。他の jinja chip と
  // 同様 locked にして GrapesJS に逐語保存させる。source は data-opaque にあり、保存時に
  // `jinjaMask` の `toTemplate` が復元する。
  // jinja-script: <script>。jinja-math: MathJax(TeX)と MathML の <math>。
  for (const type of ['jinja-script', 'jinja-math'] as const) {
    dc.addType(type, {
      model: {
        defaults: {
          ...common,
          name: type === 'jinja-math' ? '数式' : 'スクリプト',
          draggable: true,
          removable: true,
          copyable: false,
        },
      },
    });
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
/* 差し込み（値）は自動入力された値そのもの。地の本文と同じ見た目で表示し、
   チップの青箱（背景/枠/monospace/縮小フォント）を打ち消す。data-jinja は維持
   されるので選択も toTemplate 復元も不変。 */
.jinja-chip.jinja-var {
  display: inline;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}
.jinja-chip.jinja-stmt { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
.jinja-chip.jinja-comment { background: #e5e7eb; color: #6b7280; border: 1px dashed #9ca3af; }
.jinja-chip.jinja-script { background: #ede9fe; color: #5b21b6; border: 1px solid #c4b5fd; }
.jinja-chip.jinja-math { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
[data-jinja-open] { outline: 1px dashed #f59e0b; outline-offset: 2px; }
`;
