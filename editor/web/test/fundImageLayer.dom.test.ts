// =============================================================================
// fundImageLayer.dom.test.ts — 編集画面のファンド別画像(CSS で差す・保存内容を変えない)
// =============================================================================
// 主張は 3 つ。
//   1. canvas の `<img>` を走査して、対象にだけ `content:url()` の規則を書く(属性は触らない)。
//   2. 文字編集の取り込み直し・ペーストを経ても、保存出力(getBodyHtml → toTemplate)は原文の
//      `src` のままで、配信 URL が混ざらない。
//   3. GrapesJS の代替画像処理(onError で src を差し替える)が対象の `src` で止まる。
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachFundImages,
  FUND_IMAGE_STYLE_ATTR,
  type FundImageHost,
} from '@/features/editor/fundImageLayer';
import { cssString, type FundImageContext } from '@/features/editor/fundImages';
import { useGrapes } from '@/features/editor/useGrapes';
import { toTemplate } from '@/lib/jinjaMask';

const JINJA: FundImageContext = { mode: 'jinja', fundCode: '510037' };
const FILLED: FundImageContext = { mode: 'filled', fundCode: '510037' };

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
      '<img src="images/{{ fund.code }}_logo.svg"><img src="images/510037_seal.png">' +
      '<img src="photos/x.png"><img src="images/{{ report.x }}.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    const onImagesReady = vi.fn();
    attachFundImages(host, {
      getContext: () => JINJA,
      onImagesReady,
      onWarningChange: vi.fn(),
      preload,
      schedule: (cb) => cb(),
    });
    emit('load');
    const css = styleText();
    expect(css).toContain(
      'img[src="images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}',
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
      '<img id="bad" src="images/{{ fund.code }}_logo.svg"><img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const onWarningChange = vi.fn();
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange,
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    expect(onWarningChange).toHaveBeenLastCalledWith(true);
    expect(styleText()).not.toContain('{{');
    expect(styleText()).toContain('img[src="images/510037_logo.svg"]');
    document.getElementById('bad')?.remove();
    emit('component:remove');
    expect(onWarningChange).toHaveBeenLastCalledWith(false);
  });

  it('同じ内容では style を書き直さず、同じ URL は 1 度しか先読みしない', () => {
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
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
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    document.head.innerHTML = '';
    layer.refresh();
    expect(styleText()).toContain('img[src="images/510037_logo.svg"]');
  });

  it('書いたセレクタは引用符・空白を含む src の <img> に実際に一致する', () => {
    const src = 'images/510037_a"b c.svg';
    const img = document.createElement('img');
    img.setAttribute('src', src);
    document.body.appendChild(img);
    expect(document.querySelectorAll(`img[src=${cssString(src)}]`)).toHaveLength(1);
  });

  it('先読みの既定実装(Image)でも落ちない', () => {
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
    });
    expect(() => emit('load')).not.toThrow();
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
      '<div class="page"><p class="t">見出し<img src="images/{{ fund.code }}_logo.svg" alt=""></p></div>',
      '',
    );
    const wrapper = g.editor.value?.getWrapper();
    const p = wrapper ? findByClass(wrapper, 't') : undefined;
    expect(p).toBeDefined();
    // RTE の終了時と同じく、編集後の innerHTML でテキスト component の中身を作り直す。
    p?.components('見出し改<img src="images/{{ fund.code }}_logo.svg" alt="">');
    // ペースト相当(兄弟へ HTML を足す)。
    p?.parent()?.append('<img src="images/510037_seal.png">');
    const saved = toTemplate(g.getBodyHtml(), { asFragment: true });
    expect(saved).toContain('src="images/{{ fund.code }}_logo.svg"');
    expect(saved).toContain('src="images/510037_seal.png"');
    expect(saved).not.toContain('fund-assets');
    expect(g.getCss()).not.toContain('fund-assets');
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
    const target = fake('images/{{ fund.code }}_logo.svg');
    View.prototype.onError.call(target);
    expect(target.el.src).toBe('images/{{ fund.code }}_logo.svg');
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
        get: (key: string) => (key === 'src' ? 'images/{{ fund.code }}_logo.svg' : undefined),
        getSrcResult: () => 'data:image/svg+xml;base64,FALLBACK',
      },
      el: { src: 'images/{{ fund.code }}_logo.svg', srcset: '' },
    };
    View.prototype.onError.call(t);
    expect(t.el.src).toBe('data:image/svg+xml;base64,FALLBACK');
  });
});
