// =============================================================================
// bodyStyle.dom.test.ts — 本文の `<style>` を保存で失わず、canvas では効かせる
// =============================================================================
// GrapesJS のパーサは本文の `<style>` を取り除いて規則を CSS の入れ物へ移し、`load` の
// `setStyle(css)` がその入れ物を入れ替えるので、何もしなければ本文の `<style>` は保存で消える。
// 主張は 3 つ。
//   1. 編集タブ(値入り HTML)・作成タブ(`toFilled` → `toTemplate`)のどちらでも、保存出力に
//      原文の `<style>` がそのまま残る。Undo の snapshot・下書きの再読込(`load(getBodyHtml())`)も同じ。
//   2. canvas では canvas 専用の複製(`data-canvas-css-assets`)で規則が効き、複製は保存出力
//      (getBodyHtml / getCss)に載らない。
//   3. Jinja を含む `<style>` は従来どおり原文を運ぶチップで、canvas の複製は作らない。
import { buildSampleData, type FundMaster } from '@editor/shared';
import grapesjs, { type Component } from 'grapesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_STYLE_TYPE,
  BODY_STYLE_VIEW_ATTR,
  bodyStyleCssTexts,
  bodyStyleParserHtml,
  renderJinjaStyleCss,
} from '@/features/editor/bodyStyle';
import { CANVAS_CSS_ASSET_ATTR } from '@/features/editor/fundImageLayer';
import { strayDirectChildren } from '@/features/editor/pageView';
import { partsOf } from '@/features/editor/partKey';
import { useGrapes } from '@/features/editor/useGrapes';
import { toFilled } from '@/lib/fillJinja';
import { toTemplate } from '@/lib/jinjaMask';
import fundMaster from '../src/api/fixtures/funds.json';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

const sample = buildSampleData((fundMaster as FundMaster[])[0]);

const STYLE = '<style>.a{color:red}</style>';
const BODY = `<p>x</p>${STYLE}`;

/** `<style>` の開始タグの数。 */
function styleCount(html: string): number {
  return html.match(/<style[\s>]/gi)?.length ?? 0;
}

/** jsdom では canvas の iframe に document が無いので、複製の置き場を別の document で代える。 */
function canvasDoc(g: ReturnType<typeof useGrapes>): Document {
  const doc = document.implementation.createHTMLDocument('');
  const canvas = g.editor.value?.Canvas;
  if (!canvas) throw new Error('editor が無い');
  vi.spyOn(canvas, 'getDocument').mockReturnValue(doc);
  return doc;
}

function copyIn(doc: Document): string {
  return doc.body.querySelector(`style[${CANVAS_CSS_ASSET_ATTR}]`)?.textContent ?? '';
}

describe('本文の <style>', () => {
  let g: ReturnType<typeof useGrapes>;
  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  });

  it('編集タブ: 読み込み → 保存で原文の <style> が残り、CSS の入れ物へ移らない', () => {
    g.load(BODY, '.b{color:blue}');
    const html = g.getBodyHtml();
    expect(html).toContain(STYLE);
    expect(styleCount(html)).toBe(1);
    expect(g.getCss()).not.toContain('.a');
  });

  it('編集タブ: 原文の書き方(属性・子結合子・コメント)をそのまま保つ', () => {
    const style = '<style media="print">/* c */ .a > .b{color:red}\n.c{margin:0}</style>';
    g.load(`<div class="page">${style}<p class="b">y</p></div>`, '');
    expect(g.getBodyHtml()).toContain(style);
  });

  it('編集タブ: Undo の snapshot・下書きの再読込(load(getBodyHtml()))を繰り返しても残る', () => {
    g.load(BODY, '');
    for (let i = 0; i < 3; i++) g.load(g.getBodyHtml(), g.getCss());
    const html = g.getBodyHtml();
    expect(html).toContain(STYLE);
    expect(styleCount(html)).toBe(1);
    expect(g.getCss()).not.toContain('.a');
  });

  it('作成タブ: toFilled → 読み込み → toTemplate で原文の <style> が残る', () => {
    const raw = `<p>{{ fund.name }}</p>${STYLE}`;
    g.load(toFilled(raw, sample), '');
    g.setVarsHighlight(true);
    const saved = toTemplate(g.getBodyHtml(), { asFragment: true });
    expect(saved).toContain(STYLE);
    expect(saved).toContain('{{ fund.name }}');
    expect(styleCount(saved)).toBe(1);
    // 再読込(下書き)でも同じ。
    g.load(g.getBodyHtml(), g.getCss());
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toContain(STYLE);
  });

  it('Jinja を含む <style> は従来どおり原文を運ぶチップで、toTemplate で原文へ戻る', () => {
    const jinjaStyle = '<style>.a{color:{{ fund.code }}}</style>';
    g.load(toFilled(`<p>x</p>${jinjaStyle}${STYLE}`, sample), '');
    const html = g.getBodyHtml();
    expect(html).toContain('jinja-rawtext');
    const saved = toTemplate(html, { asFragment: true });
    expect(saved).toContain(jinjaStyle);
    expect(saved).toContain(STYLE);
  });

  it('canvas では複製の <style> で規則が効き、複製は保存出力に載らない', () => {
    const doc = canvasDoc(g);
    expect(g.load(BODY, '.b{color:blue}')).toBe(true);
    expect(copyIn(doc)).toBe('.a{color:red}');
    expect(g.getBodyHtml()).not.toContain(CANVAS_CSS_ASSET_ATTR);
    expect(g.getCss()).not.toContain('.a');
    // 再読込でも複製は 1 つだけ。
    g.load(g.getBodyHtml(), g.getCss());
    expect(copyIn(doc)).toBe('.a{color:red}');
    expect(doc.querySelectorAll(`style[${CANVAS_CSS_ASSET_ATTR}]`)).toHaveLength(1);
  });

  it('描画用のサンプルが無い(編集タブ)ときは Jinja を含む <style> を複製しない', () => {
    const doc = canvasDoc(g);
    g.load(toFilled('<p>x</p><style>.j{color:{{ fund.code }}}</style>', sample), '');
    expect(copyIn(doc)).not.toContain('.j');
  });

  it('作成タブ: Jinja を含む <style> はサンプルで描画した規則を複製し、保存は原文のまま', () => {
    const doc = canvasDoc(g);
    const data = { ...sample, x: { color: 'red', bg: 'url(https://e.example/x.png)' } };
    g.setStyleSample(data);
    const raw =
      '<p>{{ fund.name }}</p><style>.j{color:{{ x.color }}}</style>' +
      '<style>.k{background:{{ x.bg }}}</style>' +
      STYLE;
    g.load(toFilled(raw, data), '');
    g.setVarsHighlight(true);
    // 文書の順に並び、外部参照になった規則は落ちる。ハイライトの印は CSS に混ざらない。
    expect(copyIn(doc)).toBe('.j{color:red}\n.a{color:red}');
    const html = g.getBodyHtml();
    expect(html).not.toContain('.j{color:red}');
    expect(g.getCss()).not.toContain('.j');
    const saved = toTemplate(html, { asFragment: true });
    expect(saved).toContain('<style>.j{color:{{ x.color }}}</style>');
    expect(saved).toContain('<style>.k{background:{{ x.bg }}}</style>');
    // サンプルを外すと(編集タブへ切り替えた後の読み込み)複製しない。
    g.setStyleSample(null);
    g.load(html, '');
    expect(copyIn(doc)).toBe('.a{color:red}');
  });

  it('本文の <style> を消すと canvas の複製からも消え、保存出力にも残らない', () => {
    const doc = canvasDoc(g);
    g.load(BODY, '');
    const wrapper = g.editor.value?.getWrapper();
    const style = wrapper?.components().find((c: Component) => c.get('tagName') !== 'p');
    expect(style).toBeDefined();
    style?.remove();
    expect(styleCount(g.getBodyHtml())).toBe(0);
    expect(copyIn(doc)).not.toContain('.a');
  });

  it('<style> を含むパーツを消しても canvas の複製から消える。空白だけの <style> は複製しない', () => {
    const doc = canvasDoc(g);
    g.load(`<div class="page"><div class="w">${STYLE}</div><style> </style><p>z</p></div>`, '');
    expect(copyIn(doc)).toBe('.a{color:red}');
    const page = g.editor.value?.getWrapper()?.components().at(0);
    page?.components().at(0)?.remove();
    expect(copyIn(doc)).toBe('');
    expect(g.getBodyHtml()).toContain('<style> </style>');
    expect(bodyStyleCssTexts(undefined)).toEqual([]);
  });

  it('置き場を名乗る利用者の要素は、原文を運ぶ部品にならない', () => {
    g.load('<span data-body-style="&lt;script&gt;x&lt;/script&gt;">y</span>', '');
    const html = g.getBodyHtml();
    expect(html).not.toContain('<script');
    expect(html).toContain('>y</span>');
  });

  it('SVG の中の <style> は差し替えない(子要素の属性が刈り取りを素通りしない)', () => {
    const svg =
      '<svg viewBox="0 0 1 1"><style>.s{fill:red}<a onclick="alert(1)">t</a></style>' +
      '<rect class="s"></rect></svg>';
    g.load(`<div class="page">${svg}</div>`, '');
    const html = g.getBodyHtml();
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert');
  });

  it('赤入れの基準(parseHtmlQuiet)でも <style> は部品として残る', () => {
    const defs = g.parseHtmlQuiet(BODY);
    expect(defs).toHaveLength(2);
  });
});

describe('canvas の置き場の要素', () => {
  it('パーツの数え方は置き場を数えない', () => {
    const root = document.createElement('div');
    root.innerHTML = `<span ${BODY_STYLE_VIEW_ATTR}></span><p>x</p>`;
    expect(partsOf(root).map((el) => el.tagName)).toEqual(['P']);
  });

  it('保存済みの HTML(承認・比較)の <style> もパーツに数えない', () => {
    const root = document.createElement('div');
    root.innerHTML = '<style>.a{}</style><p>x</p>';
    expect(partsOf(root).map((el) => el.tagName)).toEqual(['P']);
  });

  it('ページ表示の制御(孤立要素)も置き場を数えない', () => {
    const body = document.createElement('body');
    body.innerHTML = `<span ${BODY_STYLE_VIEW_ATTR}></span><div class="page"></div><p>y</p>`;
    expect(strayDirectChildren(body).map((el) => el.tagName)).toEqual(['P']);
  });
});

describe('renderJinjaStyleCss', () => {
  it('<style> 1 つの原文をサンプルで描画して中身を返す', () => {
    expect(renderJinjaStyleCss('<style>.a{color:{{ c }}}</style>', { c: 'red' })).toBe(
      '.a{color:red}',
    );
  });

  it.each([
    ['字句・構造の誤り', '<style>{% if %}.a{}</style>'],
    ['<style> 以外が混ざる', '<style>.a{}</style><p>x</p>'],
    ['<style> ではない', '{% raw %}x{% endraw %}'],
  ])('%s は null(複製しない)', (_, source) => {
    expect(renderJinjaStyleCss(source, {})).toBeNull();
  });
});

describe('bodyStyleParserHtml(既定のパーサと同じ手順)', () => {
  it('head に入った script は body の末尾へ、その他は body の先頭へ移す', () => {
    const body = bodyStyleParserHtml('<title>t</title><script>s</script><p>a</p>', {});
    expect(Array.from(body.children, (el) => el.tagName)).toEqual(['TITLE', 'P', 'SCRIPT']);
    // body より head の要素が多くても、残りは順に body の末尾へ並ぶ。
    const only = bodyStyleParserHtml('<title>t</title><meta name="a"><link rel="x">', {});
    expect(Array.from(only.children, (el) => el.tagName)).toEqual(['TITLE', 'META', 'LINK']);
  });

  it('文書として解くときは文書を返し、<style> は置き場へ差し替える', () => {
    const doc = bodyStyleParserHtml('<html><head><style>.a{}</style></head><body></body></html>', {
      asDocument: true,
    }) as unknown as Document;
    expect(doc.querySelector('style')).toBeNull();
    expect(doc.head.querySelector('span')).not.toBeNull();
  });

  it('text/html 以外は div で包んで解く', () => {
    const xhtml = '<style xmlns="http://www.w3.org/1999/xhtml">.a{}</style>';
    const root = bodyStyleParserHtml(`${xhtml}<style>.b{}</style><p/>`, {
      htmlType: 'application/xml',
    });
    expect(root.tagName).toBe('div');
    // HTML の名前空間の <style> だけを差し替え、名前空間の無い要素は既定の扱いに任せる。
    expect(Array.from(root.children, (el) => el.localName)).toEqual(['span', 'style', 'p']);
  });

  it('canvas の置き場は inline の important で隠し、目印を付ける', () => {
    const g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    const View = g.editor.value?.DomComponents.getType(BODY_STYLE_TYPE)?.view as unknown as {
      prototype: { onRender(this: { el: HTMLElement }): void };
    };
    const el = document.createElement('span');
    View.prototype.onRender.call({ el });
    expect(el.style.getPropertyValue('display')).toBe('none');
    expect(el.style.getPropertyPriority('display')).toBe('important');
    expect(el.hasAttribute(BODY_STYLE_VIEW_ATTR)).toBe(true);
  });
});

describe('<style> の無い入力は既定のパーサと同じ結果になる', () => {
  function parserOf(parser?: { parserHtml: typeof bodyStyleParserHtml }) {
    const ed = grapesjs.init({
      container: document.createElement('div'),
      storageManager: false,
      ...(parser ? { parser } : {}),
    });
    return (html: string) => JSON.stringify(ed.Parser.parseHtml(html));
  }

  it.each([
    '<p class="a">x<b>y</b></p>',
    '<!-- c --><div><span data-x="1">z</span></div>',
    '<table><tr><td>1</td></tr></table><p>t</p>',
    '<title>t</title><script>s</script><meta name="a"><p>a</p>',
    '<body><p>b</p></body>',
    '<svg viewBox="0 0 1 1"><rect width="1"></rect></svg>',
  ])('%s', (html) => {
    expect(parserOf({ parserHtml: bodyStyleParserHtml })(html)).toBe(parserOf()(html));
  });
});
