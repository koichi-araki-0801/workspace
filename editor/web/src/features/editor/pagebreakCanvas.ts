// =============================================================================
// pagebreakCanvas.ts — 改ページの区切り(`div.pagebreak`)の部品の型と canvas の帯
// =============================================================================
// 区切りは中身の無い `div` で、テンプレの CSS では高さ 0 か `display:none` のことが多い。その
// ままでは canvas で見えず、選ぶことも消すこともできない。canvas 専用の CSS で根の直下の区切りを
// 点線の帯として見せ、部品の型で「改ページ」という名前と操作可否を決める。
//
// 帯の CSS は `useGrapes.ts` が canvas の head へ注入するだけで、保存 CSS(`getCss`)にも本文にも
// 出ない。PDF・プレビューは保存内容から描くので、帯はそちらに現れない。作成タブ・編集タブの
// どちらでも同じ帯を出す(区切りは 2 系統で意味が変わらない)。

import type { Editor } from 'grapesjs';
import { isPagebreakEl } from '@/lib/pageBreaks';

/** 区切りの部品の型。 */
export const PAGEBREAK_TYPE = 'pagebreak';

/**
 * 区切りの部品の型を登録する。判定は `@/lib/pageBreaks` のページの数え方と同じ
 * (`isPagebreakEl`)にし、帯の出る要素と区切りとして数える要素を一致させる。
 *
 * 選んで Delete で消せる(編集を許可していないときの削除の禁止は、他のパーツと同じく
 * `useEditorShortcuts.ts` の `canRemove` が受け持つ)。中に何も入れられず、複製もしない。
 * 自動 id を作らせないよう、スタイルも当てさせない。
 */
export function registerPagebreakComponent(editor: Editor): void {
  editor.DomComponents.addType(PAGEBREAK_TYPE, {
    isComponent: (el: unknown) => {
      const e = el as Partial<Element> | null;
      return typeof e?.classList?.contains === 'function' && isPagebreakEl(e as Element);
    },
    model: {
      defaults: {
        name: '改ページ',
        droppable: false,
        copyable: false,
        stylable: false,
        removable: true,
      },
    },
  });
}

/**
 * canvas で根の直下の区切りを帯として見せる CSS。テンプレの CSS(`display:none` や高さ 0 など)に
 * 負けないよう、帯の箱を決める宣言は `!important` にする。根の直下でない区切りはページとして
 * 数えないので帯を付けない(警告で知らせる)。
 *
 * 1 ページ表示で他ページの帯を隠す `pageView.ts` の `pageViewCss` は、この規則より詳細度が高い
 * ことに頼る。セレクタを変えるときはそちらの詳細度も見直す。
 */
export const pagebreakCanvasCss = `
[data-gjs-type=wrapper] > div.pagebreak {
  display: block !important;
  position: relative !important;
  box-sizing: border-box !important;
  height: 14px !important;
  margin: 8px 0 !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: visible !important;
}
[data-gjs-type=wrapper] > div.pagebreak::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 6px;
  border-top: 2px dashed #94a3b8;
}
[data-gjs-type=wrapper] > div.pagebreak::after {
  content: '改ページ';
  position: absolute;
  left: 50%;
  top: 0;
  transform: translateX(-50%);
  padding: 0 6px;
  background: #fff;
  color: #64748b;
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
}
`;
