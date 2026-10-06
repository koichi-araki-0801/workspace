// =============================================================================
// bodyStyle.ts — 本文の `<style>` を原文のまま運ぶ GrapesJS の部品
// =============================================================================
// GrapesJS のパーサは本文の `<style>` を取り除き、規則を CSS の入れ物へ移す。`load` はその後
// `setStyle(css)` で入れ物をテンプレの CSS に入れ替えるので、本文の `<style>` は保存
// (`getBodyHtml` / `getCss`)から消える。入れ物に残したとしても、保存 CSS(テンプレ単位の
// ファイル)へ混ざって本文から消える点は同じ。
//
// そこでパーサが取り除く前に、`<style>` を中身の無い置き場の要素へ差し替え、原文(要素 1 つの
// HTML)を部品のモデルに持たせる。部品の `toHTML` は原文をそのまま返すので、保存・Undo の
// snapshot・下書きの再読込はどれも原文の `<style>` を通り、読み込むたびに同じ部品へ戻る。
// 往復用の印(`data-opaque` など)を保存へ出さないので、印を拒む編集タブの関所とも、
// `toTemplate` で原文へ戻す作成タブとも両立する。原文は DOM の属性ではなくモジュール内の対応表で
// 渡すので、利用者の HTML が置き場を名乗って任意の HTML を保存へ書かせることはできない。
//
// 置き場は canvas では常に隠す。規則は canvas 専用の複製(`fundImageLayer.ts` の
// `data-canvas-css-assets`)で効かせ、保存内容には何も足さない。中に Jinja を含む `<style>` は
// `fillJinja` が原文を運ぶチップ(`jinja-rawtext`)にしているので、ここには来ない。

import type { Component, CustomParserHtml, Editor } from 'grapesjs';

/** 本文の `<style>` の部品の型。 */
export const BODY_STYLE_TYPE = 'body-style';

/**
 * canvas の置き場の要素に付ける目印(view だけに付け、モデルにも保存出力にも無い)。
 * パーツの数え方(`partKey.ts`)が置き場を数えないために見る。
 */
export const BODY_STYLE_VIEW_ATTR = 'data-body-style';

/** 置き場の要素 → 差し替えた `<style>` の原文と中身。パーサの 1 回の呼び出しの中で引く。 */
const placeholders = new WeakMap<Element, { source: string; css: string }>();

/** 文書の中の `<style>` をすべて置き場へ差し替える(SVG の中の `<style>` も同じく消されるので含める)。 */
function swapStyles(doc: Document): void {
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const holder = doc.createElement('span');
    placeholders.set(holder, { source: style.outerHTML, css: style.textContent ?? '' });
    style.replaceWith(holder);
  }
}

/**
 * GrapesJS 既定の HTML パーサ(`BrowserParserHtml`)と同じ手順で解析し、`<style>` を置き場へ
 * 差し替えてから返す。既定のパーサは公開されていないので、同じ手順をここに持つ。
 */
export const bodyStyleParserHtml: CustomParserHtml = (str, options) => {
  const parser = new DOMParser();
  const mimeType = options.htmlType || 'text/html';
  if (mimeType !== 'text/html') {
    const doc = parser.parseFromString(`<div>${str}</div>`, mimeType);
    swapStyles(doc);
    return doc.firstChild as HTMLElement;
  }
  const doc = parser.parseFromString(str, mimeType);
  swapStyles(doc);
  if (options.asDocument) return doc as unknown as HTMLElement;
  const { head, body } = doc;
  // 既定のパーサと同じく、head の script を body の末尾へ、head の残りを body の先頭へ移す。
  for (const node of Array.from(head.querySelectorAll('script'))) body.appendChild(node);
  Array.from(head.children).forEach((node, i) => {
    body.insertBefore(node, body.children[i] ?? null);
  });
  return body;
};

/**
 * 本文の `<style>` の部品を登録する。読み込みのたびに作り直されるので、複製や移動の対象には
 * しない(Undo は snapshot の再読込で戻る)。
 */
export function registerBodyStyleComponent(editor: Editor): void {
  editor.DomComponents.addType(BODY_STYLE_TYPE, {
    isComponent: (el: unknown) => {
      const hit = placeholders.get(el as Element);
      return hit ? { type: BODY_STYLE_TYPE, styleSource: hit.source, styleCss: hit.css } : false;
    },
    model: {
      defaults: {
        name: 'CSS（本文の <style>）',
        tagName: 'span',
        editable: false,
        droppable: false,
        copyable: false,
        stylable: false,
        draggable: false,
        removable: true,
        styleSource: '',
        styleCss: '',
      },
      toHTML(this: Component) {
        return this.get('styleSource') as string;
      },
    },
    view: {
      onRender(this: { el: HTMLElement }) {
        // ページ表示の制御(`pageView.ts` の `display:block !important`)にも勝つよう、inline の
        // important で隠す。view の要素だけに書くのでモデル(保存内容)には現れない。
        this.el.style.setProperty('display', 'none', 'important');
        this.el.setAttribute(BODY_STYLE_VIEW_ATTR, '');
      },
    },
  });
}

/** 部品の木の中の、本文の `<style>` の中身(文書の順)。空白だけのものは除く。 */
export function bodyStyleCssTexts(root: Component | undefined): string[] {
  if (!root) return [];
  return root
    .findType(BODY_STYLE_TYPE)
    .map((c) => c.get('styleCss') as string)
    .filter((css) => css.trim() !== '');
}

/** 部品(子孫を含む)に本文の `<style>` があるか。 */
export function containsBodyStyle(c: Component): boolean {
  return c.get('type') === BODY_STYLE_TYPE || c.findType(BODY_STYLE_TYPE).length > 0;
}
