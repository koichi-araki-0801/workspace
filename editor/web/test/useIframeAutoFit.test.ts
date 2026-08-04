// =============================================================================
// useIframeAutoFit.test.ts — srcdoc iframe 自動フィット composable の単体テスト (vitest)
// =============================================================================
// 高さは子からの postMessage で受け取る(`sandbox="allow-scripts"` = same-origin なしでは
// 親から `contentDocument` を読めない)。jsdom は iframe のレイアウトを計算しないので、
// `contentWindow` を差し替えた疑似 iframe へ `message` イベントを流して検証する。
//
// 主張の中心は**迂回入力を反映しないこと**: 別フレームからの通知・型違い・非現実的な
// 巨大値は、いずれも子(信用できないテンプレ HTML)が自由に送れる。
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { FRAME_HEIGHT_MESSAGE, useIframeAutoFit } from '@/lib/useIframeAutoFit';

afterEach(() => vi.restoreAllMocks());

/** `contentWindow` と `style` だけを持つ疑似 iframe を @load イベント化する。 */
function fakeFrame() {
  const contentWindow = {} as Window;
  const iframe = { contentWindow, style: { height: '' } as { height: string } };
  return { iframe, contentWindow, event: { target: iframe } as unknown as Event };
}

/** 子 → 親の通知を模す。`source` は MessageEvent の read-only なので手組みする。 */
function postHeight(source: unknown, payload: unknown): void {
  const ev = new MessageEvent('message', { data: payload });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

function mountHost() {
  let api: ReturnType<typeof useIframeAutoFit> | null = null;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useIframeAutoFit();
        return () => h('div');
      },
    }),
  );
  return { wrapper, api: api as unknown as ReturnType<typeof useIframeAutoFit> };
}

const height = (h: number) => ({ type: FRAME_HEIGHT_MESSAGE, height: h });

describe('useIframeAutoFit', () => {
  it('登録した iframe からの通知を高さへ反映する(+4px)', () => {
    const { api } = mountHost();
    const { iframe, contentWindow, event } = fakeFrame();
    api.fitFrame(event);
    postHeight(contentWindow, height(120));
    expect(iframe.style.height).toBe('124px');
  });

  it('別フレームからの通知は反映しない(origin では判別できないので source で照合する)', () => {
    // opaque origin の子は `event.origin === 'null'` になり、他の任意 sandbox フレームと
    // 一致してしまう。source 照合でなければ、無関係な iframe が高さを乗っ取れる。
    const { api } = mountHost();
    const { iframe, event } = fakeFrame();
    api.fitFrame(event);
    postHeight({} as Window, height(999));
    expect(iframe.style.height).toBe('');
  });

  it('type が違う message は無視する', () => {
    const { api } = mountHost();
    const { iframe, contentWindow, event } = fakeFrame();
    api.fitFrame(event);
    postHeight(contentWindow, { type: 'other', height: 500 });
    postHeight(contentWindow, null);
    postHeight(contentWindow, 'editor:frame-height');
    expect(iframe.style.height).toBe('');
  });

  it.each([
    ['x' as unknown],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [0],
    [-10],
  ])('height が %s なら反映しない', (bad) => {
    const { api } = mountHost();
    const { iframe, contentWindow, event } = fakeFrame();
    api.fitFrame(event);
    postHeight(contentWindow, { type: FRAME_HEIGHT_MESSAGE, height: bad });
    expect(iframe.style.height).toBe('');
  });

  it('巨大な高さは上限で頭打ちにする(親のレイアウトを潰させない)', () => {
    const { api } = mountHost();
    const { iframe, contentWindow, event } = fakeFrame();
    api.fitFrame(event);
    postHeight(contentWindow, height(10_000_000));
    expect(iframe.style.height).toBe('200004px');
  });

  it('unmount 後は購読を解除する', () => {
    const { wrapper, api } = mountHost();
    const { iframe, contentWindow, event } = fakeFrame();
    api.fitFrame(event);
    wrapper.unmount();
    postHeight(contentWindow, height(300));
    expect(iframe.style.height).toBe('');
  });

  it('withHeightReporter は本文を書き換えず末尾へ計測スクリプトを足すだけ', () => {
    // 中間へ差し込む文字列手術はテンプレの形の差で壊れる。前方一致で不変を主張する。
    const { api } = mountHost();
    const doc = '<!doctype html><html><body><p>本文</p></body></html>';
    const out = api.withHeightReporter(doc);
    expect(out.startsWith(doc)).toBe(true);
    expect(out.slice(doc.length)).toContain(FRAME_HEIGHT_MESSAGE);
  });
});
