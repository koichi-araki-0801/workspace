// =============================================================================
// fundImageLayer.dom.test.ts — 編集画面のファンド別画像(CSS で差す・保存内容を変えない)
// =============================================================================
// 主張は 3 つ。
//   1. canvas の `<img>` を走査して、対象にだけ `content:url()` の規則を書く(属性は触らない)。
//   2. 文字編集の取り込み直し・ペーストを経ても、保存出力(getBodyHtml → toTemplate)は原文の
//      `src` のままで、配信 URL が混ざらない。
//   3. GrapesJS の代替画像処理(onError で src を差し替える)が対象の `src` で止まる。
import { DOC_DIR } from '@editor/shared';
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachFundImages,
  CANVAS_CSS_ASSET_ATTR,
  FUND_IMAGE_STYLE_ATTR,
  type FundImageHost,
} from '@/features/editor/fundImageLayer';
import { cssString, type FundImageContext } from '@/features/editor/fundImages';
import { useGrapes } from '@/features/editor/useGrapes';
import { FUND_IMAGE_WARNING_MESSAGE } from '@/lib/assetWarnings';
import { TEMPLATE_CSS_FROM } from '@/lib/fundImages';
import { toTemplate } from '@/lib/jinjaMask';

const JINJA: FundImageContext = { mode: 'jinja', fundCode: '510037', companyCode: 'AM01' };
const FILLED: FundImageContext = { mode: 'filled', fundCode: '510037', companyCode: 'AM01' };

/** `on` で張られた handler を名前で呼べる最小の editor。canvas の document は jsdom のもの。 */
function fakeHost(doc: Document) {
  const handlers = new Map<string, Array<() => void>>();
  const host = {
    on: (event: string, cb: () => void) => {
      for (const e of event.split(' ')) handlers.set(e, [...(handlers.get(e) ?? []), cb]);
    },
    Canvas: { getDocument: () => doc },
  } as unknown as FundImageHost;
  const emit = (event: string) => {
    for (const cb of handlers.get(event) ?? []) cb();
  };
  return { host, emit };
}

const styleText = (): string =>
  document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`)?.textContent ?? '';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('attachFundImages', () => {
  it('Jinja 本文: 対象の <img> にだけ規則を書き、先読み後に再計測を呼ぶ', async () => {
    document.body.innerHTML =
      '<img src="../images/{{ fund.code }}_logo.svg"><img src="../images/510037_seal.png">' +
      '<img src="photos/x.png"><img src="../images/{{ report.x }}.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    const onImagesReady = vi.fn();
    attachFundImages(host, {
      getContext: () => JINJA,
      onImagesReady,
      onWarningsChange: vi.fn(),
      preload,
      schedule: (cb) => cb(),
    });
    emit('load');
    const css = styleText();
    expect(css).toContain(
      'img[src="../images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}',
    );
    expect(css).toContain('/api/fund-assets/images/510037_seal.png');
    expect(css).not.toContain('photos');
    expect(css).not.toContain('report');
    expect(preload.mock.calls.map(([u]) => u).sort()).toEqual([
      '/api/fund-assets/images/510037_logo.svg',
      '/api/fund-assets/images/510037_seal.png',
    ]);
    await vi.waitFor(() => expect(onImagesReady).toHaveBeenCalledTimes(1));
    // 属性は 1 つも書き換えていない。
    expect(document.body.innerHTML).not.toContain('fund-assets');
  });

  it('値入り本文: {{ の残る参照は差さずに警告し、消えたら警告を下ろす', () => {
    document.body.innerHTML =
      '<img id="bad" src="../images/{{ fund.code }}_logo.svg"><img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const onWarningsChange = vi.fn();
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange,
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    expect(onWarningsChange).toHaveBeenLastCalledWith([FUND_IMAGE_WARNING_MESSAGE]);
    expect(styleText()).not.toContain('{{');
    expect(styleText()).toContain('img[src="../images/510037_logo.svg"]');
    document.getElementById('bad')?.remove();
    emit('component:remove');
    expect(onWarningsChange).toHaveBeenLastCalledWith([]);
  });

  it('同じ内容では style を書き直さず、同じ URL は 1 度しか先読みしない', () => {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload,
      schedule: (cb) => cb(),
    });
    emit('load');
    const el = document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`);
    emit('component:update');
    emit('component:add');
    expect(document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`)).toBe(el);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('canvas の document が作り直されたら style を作り直す', () => {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    document.head.innerHTML = '';
    layer.refresh();
    expect(styleText()).toContain('img[src="../images/510037_logo.svg"]');
  });

  it('書いたセレクタは引用符・空白を含む src の <img> に実際に一致する', () => {
    const src = '../images/510037_a"b c.svg';
    const img = document.createElement('img');
    img.setAttribute('src', src);
    document.body.appendChild(img);
    expect(document.querySelectorAll(`img[src=${cssString(src)}]`)).toHaveLength(1);
  });

  it('destroy の後は、予約済みの走査も以後の契機も canvas に触れない', () => {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const getDocument = vi.spyOn(host.Canvas, 'getDocument');
    const queued: Array<() => void> = [];
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => queued.push(cb),
    });
    emit('component:remove');
    layer.destroy();
    // editor の破棄は Canvas を外したうえで component:remove を出す。
    (host as { Canvas?: unknown }).Canvas = undefined;
    emit('component:remove');
    expect(() => {
      for (const cb of queued) cb();
      emit('load');
      layer.refresh();
    }).not.toThrow();
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('先読みの既定実装(Image)でも落ちない', () => {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
    });
    expect(() => emit('load')).not.toThrow();
  });
});

/** 大きさの変化を手で起こせる偽の ResizeObserver(jsdom には無い)。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets: Element[] = [];
  disconnected = false;
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
    this.targets = [];
  }
  fire(width: number, height: number): void {
    const entries = this.targets.map(
      (target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry,
    );
    this.cb(entries, this as unknown as ResizeObserver);
  }
}

/** テンプレの CSS だけを渡す `setCss` の入力。 */
const tpl = (css: string) => [{ css, from: TEMPLATE_CSS_FROM }];

describe('CSS の url() 規則の複製層', () => {
  const assetStyle = (): Element | null =>
    document.body.querySelector(`style[${CANVAS_CSS_ASSET_ATTR}]`);

  it('url() を含む規則だけを body の末尾に置き、後ろに要素が足されたら末尾へ戻す', () => {
    document.body.innerHTML = '<div id="wrapper"></div><div id="css-rules"></div>';
    const { host, emit } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('@font-face{font-family:a;src:url(fonts/biz.woff2)}.p{color:red}'));
    expect(assetStyle()?.textContent).toContain('/api/preview-host/css/fonts/biz.woff2');
    expect(assetStyle()?.textContent).not.toContain('color:red');
    expect(document.body.lastElementChild).toBe(assetStyle());
    document.body.appendChild(document.createElement('div'));
    emit('component:add');
    expect(document.body.lastElementChild).toBe(assetStyle());
  });

  it('url() の無い CSS では body に何も足さず、複製が空になれば中身を空にする', () => {
    const { host } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('.p{color:red}'));
    expect(assetStyle()).toBeNull();
    layer.setCss(tpl('.p{background:url(../images/510037_bg.svg)}'));
    expect(assetStyle()?.textContent).toContain('/api/fund-assets/images/510037_bg.svg');
    layer.setCss(tpl('.p{color:red}'));
    expect(assetStyle()?.textContent).toBe('');
  });

  it('canvas の document が作り直されたら複製を新しい body に置き直す', () => {
    const { host } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('.p{background:url(../images/510037_bg.svg)}'));
    document.body.innerHTML = '';
    layer.refresh();
    expect(assetStyle()?.textContent).toContain('510037_bg.svg');
  });

  it('canvas の文書ができる前に setCss しても、body が描かれた時点で複製を置く', () => {
    const handlers = new Map<string, (ev?: unknown) => void>();
    const frameDoc = document.implementation.createHTMLDocument('');
    let ready = false;
    const host = {
      on: (event: string, cb: (ev?: unknown) => void) => handlers.set(event, cb),
      // GrapesJS は body の描画直後もまだ document を返さない(イベントの window から取る)。
      Canvas: { getDocument: () => (ready ? frameDoc : undefined) },
    } as unknown as FundImageHost;
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('@font-face{font-family:a;src:url(fonts/biz.woff2)}'));
    expect(frameDoc.querySelector(`style[${CANVAS_CSS_ASSET_ATTR}]`)).toBeNull();
    frameDoc.body.innerHTML = '<div id="wrapper"></div><div id="css-rules"></div>';
    handlers.get('canvas:frame:load:body')?.({ window: { document: frameDoc } });
    const placed = frameDoc.querySelector(`style[${CANVAS_CSS_ASSET_ATTR}]`);
    expect(placed?.textContent).toContain('/api/preview-host/css/fonts/biz.woff2');
    expect(frameDoc.body.lastElementChild).toBe(placed);
    ready = true;
    layer.refresh();
    expect(frameDoc.querySelectorAll(`style[${CANVAS_CSS_ASSET_ATTR}]`)).toHaveLength(1);
  });

  it('GrapesJS が canvas に書く規則の文字列では、元の @font-face の取得先を無効にする', () => {
    const handlers = new Map<string, (ev?: unknown) => void>();
    const host = {
      on: (event: string, cb: (ev?: unknown) => void) => handlers.set(event, cb),
      Canvas: { getDocument: () => document },
    } as unknown as FundImageHost;
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    const props = { css: '@font-face{font-family:a;src:url("fonts/biz.woff2");}' };
    handlers.get('css:mount:before')?.(props);
    expect(props.css).toBe('@font-face{font-family:a;src:local("");}');
  });

  it('会社コードが変わったら、走査のときに会社フォルダの照合をやり直す', () => {
    const { host } = fakeHost(document);
    let ctx: FundImageContext = FILLED;
    const layer = attachFundImages(host, {
      getContext: () => ctx,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('.p{background:url(../images/am01/qr.svg)}'));
    expect(assetStyle()?.textContent).toContain('/api/fund-assets/images/am01/qr.svg');
    ctx = { ...FILLED, companyCode: 'SMTAM' };
    layer.refresh();
    expect(assetStyle()?.textContent).toBe('');
  });

  it('CSS 内の配信されない画像参照も警告に入れる', () => {
    const { host } = fakeHost(document);
    const onWarningsChange = vi.fn();
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange,
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss(tpl('.p{background:url(../images/other/q.svg)}'));
    expect(onWarningsChange).toHaveBeenLastCalledWith([
      '会社フォルダ名がテンプレの会社コード（AM01）と違うため表示しません（../images/other/q.svg）',
    ]);
  });

  it('本文の <style> は文書の位置で解き、テンプレの CSS より前に並べる', () => {
    const { host } = fakeHost(document);
    const onWarningsChange = vi.fn();
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange,
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss([
      {
        css:
          '@font-face{font-family:F;src:url(../css/fonts/f.woff2)}' +
          '.q{background:url(../images/other/b.svg)}',
        from: DOC_DIR,
      },
      { css: '.p{background:url(../images/510037_bg.svg)}', from: TEMPLATE_CSS_FROM },
    ]);
    expect(assetStyle()?.textContent).toBe(
      '@font-face{font-family:F;src:url("/api/preview-host/css/fonts/f.woff2")}\n' +
        '.p{background:url("/api/fund-assets/images/510037_bg.svg")}',
    );
    expect(onWarningsChange).toHaveBeenLastCalledWith([
      '会社フォルダ名がテンプレの会社コード（AM01）と違うため表示しません（../images/other/b.svg）',
    ]);
  });

  it('会社コードが変わったら、本文の <style> の複製も照合をやり直す', () => {
    const { host } = fakeHost(document);
    let ctx: FundImageContext = FILLED;
    const layer = attachFundImages(host, {
      getContext: () => ctx,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    layer.setCss([
      { css: '.q{background:url(../images/am01/q.svg)}', from: DOC_DIR },
      { css: '.p{background:url(../images/am01/p.svg)}', from: TEMPLATE_CSS_FROM },
    ]);
    expect(assetStyle()?.textContent).toContain('am01/q.svg');
    expect(assetStyle()?.textContent).toContain('am01/p.svg');
    ctx = { ...FILLED, companyCode: 'SMTAM' };
    layer.refresh();
    expect(assetStyle()?.textContent).toBe('');
  });
});

describe('canvas の大きさの変化で測り直す', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
  });

  function attachWithResize() {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const onCanvasResize = vi.fn();
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      onCanvasResize,
      preload: async () => {},
      schedule: (cb) => cb(),
      ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    });
    emit('load');
    return { layer, emit, onCanvasResize };
  }

  it('body の大きさが変わったら呼び、同じ大きさでは呼ばない', () => {
    const { onCanvasResize } = attachWithResize();
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const ro = FakeResizeObserver.instances[0];
    expect(ro?.targets).toEqual([document.body]);
    ro?.fire(794, 1123);
    expect(onCanvasResize).toHaveBeenCalledTimes(1);
    ro?.fire(794, 1123);
    expect(onCanvasResize).toHaveBeenCalledTimes(1);
    ro?.fire(794, 1400);
    expect(onCanvasResize).toHaveBeenCalledTimes(2);
  });

  it('再走査では observer を作り直さず、body が替われば監視先を移す', () => {
    const { layer, emit } = attachWithResize();
    emit('component:add');
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const oldBody = document.body;
    const newBody = document.createElement('body');
    document.documentElement.replaceChild(newBody, oldBody);
    layer.refresh();
    expect(FakeResizeObserver.instances[0]?.targets).toEqual([newBody]);
  });

  it('canvas の document が替われば古い observer を外して作り直し、destroy でも外す', () => {
    let doc: Document = document;
    const host = {
      on: () => {},
      Canvas: { getDocument: () => doc },
    } as unknown as FundImageHost;
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      onCanvasResize: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
      ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
    });
    layer.refresh();
    const first = FakeResizeObserver.instances[0];
    doc = document.implementation.createHTMLDocument('frame');
    layer.refresh();
    expect(first?.disconnected).toBe(true);
    const second = FakeResizeObserver.instances[1];
    expect(second?.targets).toEqual([doc.body]);
    layer.destroy();
    expect(second?.disconnected).toBe(true);
  });

  it('ResizeObserver が無い環境では何もしない', () => {
    document.body.innerHTML = '<img src="../images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningsChange: vi.fn(),
      onCanvasResize: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    expect(() => emit('load')).not.toThrow();
    expect(() => layer.destroy()).not.toThrow();
  });
});

/** class でモデル木を探す(`saveFormat.dom.test.ts` と同じ理由で view 依存の find を避ける)。 */
function findByClass(root: Component, cls: string): Component | undefined {
  if (root.getClasses().includes(cls)) return root;
  for (const child of root.components()) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

describe('useGrapes との結合', () => {
  let g: ReturnType<typeof useGrapes>;
  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    g.setFundImageContext(JINJA);
  });

  it('文字編集の取り込み直し・ペーストの後も、保存出力は原文の src のまま', () => {
    g.load(
      '<div class="page"><p class="t">見出し<img src="../images/{{ fund.code }}_logo.svg" alt=""></p></div>',
      '',
    );
    const wrapper = g.editor.value?.getWrapper();
    const p = wrapper ? findByClass(wrapper, 't') : undefined;
    expect(p).toBeDefined();
    // RTE の終了時と同じく、編集後の innerHTML でテキスト component の中身を作り直す。
    p?.components('見出し改<img src="../images/{{ fund.code }}_logo.svg" alt="">');
    // ペースト相当(兄弟へ HTML を足す)。
    p?.parent()?.append('<img src="../images/510037_seal.png">');
    const saved = toTemplate(g.getBodyHtml(), { asFragment: true });
    expect(saved).toContain('src="../images/{{ fund.code }}_logo.svg"');
    expect(saved).toContain('src="../images/510037_seal.png"');
    expect(saved).not.toContain('fund-assets');
    expect(g.getCss()).not.toContain('fund-assets');
  });

  it('CSS の url() を直した複製は保存出力(getCss・getBodyHtml)に載らない', () => {
    const css =
      '@font-face{font-family:a;src:url(fonts/biz.woff2)}' +
      '.page{background:url(../images/510037_bg.svg)}';
    // 複製は load の中で同期に作る(rAF を待たない)ので、ここで保存出力を読めば足りる。
    expect(g.load('<div class="page"><p>x</p></div>', css)).toBe(true);
    expect(g.getCss()).not.toContain('/api/');
    // jsdom の CSSOM は `@font-face` の記述子を落とすので、原文の参照は背景画像の側で確かめる。
    expect(g.getCss()).toContain('url("../images/510037_bg.svg")');
    expect(g.getBodyHtml()).not.toContain(CANVAS_CSS_ASSET_ATTR);
    expect(g.getBodyHtml()).not.toContain('/api/');
  });

  it('本文の <style> の url() も複製し、保存出力は原文のまま', () => {
    const body =
      '<style>@font-face{font-family:F;src:url(../css/fonts/f.woff2)}</style>' +
      '<div class="page"><p>{{ fund.name }}</p></div>';
    // jsdom では canvas の iframe に document が無いので、複製の置き場を別の document で代える。
    const doc = document.implementation.createHTMLDocument('');
    const canvas = g.editor.value?.Canvas;
    if (!canvas) throw new Error('editor が無い');
    vi.spyOn(canvas, 'getDocument').mockReturnValue(doc);
    expect(g.load(body, '.page{background:url(../images/510037_bg.svg)}')).toBe(true);
    const copy = doc.body.querySelector(`style[${CANVAS_CSS_ASSET_ATTR}]`)?.textContent;
    expect(copy).toBe(
      '@font-face{font-family:F;src:url("/api/preview-host/css/fonts/f.woff2")}\n' +
        '.page{background:url("/api/fund-assets/images/510037_bg.svg")}',
    );
    expect(g.getCss()).not.toContain('/api/');
    expect(g.getBodyHtml()).not.toContain('/api/');
  });

  it('代替画像処理は対象の src で止まり、対象外では従来どおり差し替える', () => {
    const View = g.editor.value?.DomComponents.getType('image')?.view as unknown as {
      prototype: { onError(this: unknown): void };
    };
    const fake = (src: string) => ({
      model: {
        get: (key: string) => (key === 'src' ? src : undefined),
        getSrcResult: () => 'data:image/svg+xml;base64,FALLBACK',
      },
      el: { src, srcset: '' },
    });
    const target = fake('../images/{{ fund.code }}_logo.svg');
    View.prototype.onError.call(target);
    expect(target.el.src).toBe('../images/{{ fund.code }}_logo.svg');
    const other = fake('photos/x.png');
    View.prototype.onError.call(other);
    expect(other.el.src).toBe('data:image/svg+xml;base64,FALLBACK');
  });

  it('値入り本文へ切り替えると {{ の残る src は対象から外れる', () => {
    g.setFundImageContext(FILLED);
    const View = g.editor.value?.DomComponents.getType('image')?.view as unknown as {
      prototype: { onError(this: unknown): void };
    };
    const t = {
      model: {
        get: (key: string) => (key === 'src' ? '../images/{{ fund.code }}_logo.svg' : undefined),
        getSrcResult: () => 'data:image/svg+xml;base64,FALLBACK',
      },
      el: { src: '../images/{{ fund.code }}_logo.svg', srcset: '' },
    };
    View.prototype.onError.call(t);
    expect(t.el.src).toBe('data:image/svg+xml;base64,FALLBACK');
  });
});
