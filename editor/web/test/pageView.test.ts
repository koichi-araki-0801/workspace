import { describe, expect, it } from 'vitest';
import {
  clampPageIndex,
  enumeratePageEls,
  isBreakValue,
  PV_ATTR,
  pageViewCss,
  strayDirectChildren,
} from '@/features/editor/pageView';

// pageView の純粋関数(ページ列挙 / 可視制御 CSS / index クランプ)を DOM 構築のみで検証する。
// 実レイアウト(getComputedStyle/getBoundingClientRect)に依存しないため jsdom で全分岐を直接叩ける。

/** body 直下に与えた tag/class の子要素を順に並べた body を作る。 */
function makeBody(children: { tag?: string; cls?: string }[]): HTMLElement {
  const body = document.createElement('body');
  for (const c of children) {
    const el = document.createElement(c.tag ?? 'div');
    if (c.cls) el.className = c.cls;
    body.appendChild(el);
  }
  return body;
}

describe('enumeratePageEls', () => {
  it('body 直下の .page を順に列挙する', () => {
    const body = makeBody([{ cls: 'page' }, { cls: 'page' }, { cls: 'page' }]);
    const pages = enumeratePageEls(body);
    expect(pages).toHaveLength(3);
    expect(pages.every((el) => el.classList.contains('page'))).toBe(true);
  });

  it('.page 以外の直接子(div / 別 class)は除外する', () => {
    const body = makeBody([{ cls: 'page' }, { cls: 'note' }, {}, { cls: 'page' }]);
    const pages = enumeratePageEls(body);
    expect(pages).toHaveLength(2);
  });

  it('.page が 0 件なら body 全体を 1 ページ扱いの fallback にする', () => {
    const body = makeBody([{ cls: 'note' }, {}]);
    const pages = enumeratePageEls(body);
    expect(pages).toEqual([body]);
  });
});

describe('pageViewCss', () => {
  it('1 ページ表示・複数ページなら現在 index 以外を hide する CSS を返す', () => {
    const css = pageViewCss(1, 5, true);
    expect(css).toContain(`[${PV_ATTR}] { display: none !important; }`);
    expect(css).toContain(`[${PV_ATTR}="1"] { display: block !important; }`);
  });

  it('1 ページ表示でもページが 1 枚以下なら空文字(常時表示)', () => {
    expect(pageViewCss(0, 1, true)).toBe('');
    expect(pageViewCss(0, 0, true)).toBe('');
  });

  it('全ページ表示(singleMode=false)は枚数に関わらず空文字', () => {
    expect(pageViewCss(2, 5, false)).toBe('');
  });
});

describe('strayDirectChildren', () => {
  it('root 直下の .page 以外の素要素だけを返す(.page は除外)', () => {
    const root = makeBody([{ cls: 'page' }, { cls: 'note' }, {}, { cls: 'page' }]);
    const strays = strayDirectChildren(root);
    expect(strays).toHaveLength(2);
    expect(strays.every((el) => !el.classList.contains('page'))).toBe(true);
  });

  it('wrapper 直下が .page のみ(正常時)なら空配列', () => {
    const root = makeBody([{ cls: 'page' }, { cls: 'page' }]);
    expect(strayDirectChildren(root)).toEqual([]);
  });

  it('孤立要素はページ総数(enumeratePageEls)に影響しない', () => {
    const root = makeBody([{ cls: 'page' }, {}, { cls: 'page' }]);
    // 孤立要素 1 件があっても `.page` は 2 件のまま(ページャ総数は `.page` 数を維持)。
    expect(enumeratePageEls(root)).toHaveLength(2);
    expect(strayDirectChildren(root)).toHaveLength(1);
  });
});

describe('clampPageIndex', () => {
  it('負数は 0 に丸める', () => {
    expect(clampPageIndex(-3, 5)).toBe(0);
  });

  it('範囲内はそのまま', () => {
    expect(clampPageIndex(2, 5)).toBe(2);
  });

  it('超過は count-1 に丸める', () => {
    expect(clampPageIndex(9, 5)).toBe(4);
  });

  it('count=0 は 0 を返す', () => {
    expect(clampPageIndex(3, 0)).toBe(0);
  });
});

describe('isBreakValue', () => {
  it('page-break キーワード(always/page/left/right/recto/verso)を受理する', () => {
    for (const v of ['always', 'page', 'left', 'right', 'recto', 'verso']) {
      expect(isBreakValue(v)).toBe(true);
    }
  });

  it('auto / avoid / 空 / undefined は非該当', () => {
    expect(isBreakValue('auto')).toBe(false);
    expect(isBreakValue('avoid')).toBe(false);
    expect(isBreakValue('')).toBe(false);
    expect(isBreakValue(undefined)).toBe(false);
  });
});
