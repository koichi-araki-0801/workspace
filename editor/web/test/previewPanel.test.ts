// =============================================================================
// previewPanel.test.ts — 隔離 iframe の postMessage クライアント(親側)の契約
// =============================================================================
// 検証する契約は 4 つ:
//   1. 発信元検証 — `event.source === iframe.contentWindow` の同一性でだけ受ける
//      (opaque オリジンの `origin` は 'null' で識別に使えない)。
//   2. READY 前に届いた文書は保留し、READY 受信時に送る。
//   3. 子が沈黙する形の失敗は boot タイムアウトで簡易表示へ倒す。
//   4. 子からの STATE は数値正規化して親へ上げる(壊れた値で NaN を配らない)。
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewPanel from '../src/features/preview/PreviewPanel.vue';

// 自己完結化は素通しにする(その中身は previewSelfContain.test.ts が固定する)。
vi.mock('../src/lib/previewSelfContain', () => ({
  selfContainPreviewDoc: vi.fn(async (doc: string) => doc),
}));

type PanelWrapper = ReturnType<typeof mount<typeof PreviewPanel>>;

function frameWindow(wrapper: PanelWrapper): Window {
  const frame = wrapper.get('iframe[title="プレビュー"]').element as HTMLIFrameElement;
  const win = frame.contentWindow;
  if (!win) throw new Error('jsdom が contentWindow を作っていない');
  return win;
}

/** 子からのメッセージを装って親 window へ配送する(`source` を指定できる形)。 */
function deliver(data: unknown, source: Window | null): void {
  const ev = new MessageEvent('message', { data });
  // jsdom の MessageEvent は constructor で source を受けないため defineProperty で与える。
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PreviewPanel — postMessage クライアント', () => {
  it('READY 前の文書は保留し、READY 受信で子へ送る', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    const post = vi.spyOn(win, 'postMessage');

    // まだ READY が来ていない = 何も送られない。
    await flushPromises();
    expect(post).not.toHaveBeenCalled();

    deliver({ type: 'editor:preview-ready' }, win);
    await flushPromises();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'editor:preview-doc', html: '<p>doc</p>' }),
      '*',
    );
    wrapper.unmount();
  });

  it('発信元が contentWindow でないメッセージは無視する', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    const post = vi.spyOn(win, 'postMessage');

    // 別の window(ここでは親自身)を装った READY。source 同一性で落ちる。
    deliver({ type: 'editor:preview-ready' }, window);
    deliver({ type: 'editor:preview-ready' }, null);
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('READY が来ないまま boot 期限が切れると簡易表示へ倒す', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    await wrapper.get('iframe[title="プレビュー"]').trigger('load');

    vi.advanceTimersByTime(15_000);
    await flushPromises();

    const states = wrapper.emitted('state') ?? [];
    const last = states.at(-1)?.[0] as { vivlioReady: boolean };
    expect(last.vivlioReady).toBe(false);
    // 簡易表示側の iframe に本文が入る。
    const fallback = wrapper.get('iframe[title="プレビュー(簡易表示)"]')
      .element as HTMLIFrameElement;
    expect(fallback.srcdoc).toBe('<p>doc</p>');
    wrapper.unmount();
  });

  it('STATE は数値正規化して親へ上げる(壊れた値は既定値へ)', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    deliver({ type: 'editor:preview-ready' }, win);
    await flushPromises();

    deliver(
      {
        type: 'editor:preview-state',
        state: { currentPage: 'x', pageCount: 3, atFirst: undefined, atLast: 'yes', zoom: null },
      },
      win,
    );
    await flushPromises();

    const states = wrapper.emitted('state') ?? [];
    const last = states.at(-1)?.[0] as Record<string, unknown>;
    expect(last).toMatchObject({
      currentPage: 1, // Number('x') → NaN → 既定 1
      pageCount: 3,
      atFirst: true, // undefined !== false → true
      atLast: false, // 'yes' === true でない → false
      zoom: 1,
      vivlioReady: true,
    });
    wrapper.unmount();
  });

  it('子の ERROR 通知で簡易表示へ倒す', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    deliver({ type: 'editor:preview-error', message: 'boom' }, win);
    await flushPromises();

    const last = (wrapper.emitted('state') ?? []).at(-1)?.[0] as { vivlioReady: boolean };
    expect(last.vivlioReady).toBe(false);
    wrapper.unmount();
  });

  it('公開メソッドは命令として子へ届く(親は自前でページ位置を進めない)', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    const post = vi.spyOn(win, 'postMessage');
    deliver({ type: 'editor:preview-ready' }, win);
    await flushPromises();
    post.mockClear();

    const vm = wrapper.vm as unknown as Record<string, (n?: number) => void>;
    vm.prevPage();
    vm.nextPage();
    vm.goToPage(3);
    vm.zoomIn();
    vm.zoomOut();
    vm.fit();
    const cmds = post.mock.calls.map((c) => c[0] as { type: string; cmd?: string; page?: number });
    expect(cmds.map((c) => c.cmd)).toEqual([
      'prevPage',
      'nextPage',
      'goToPage',
      'zoomIn',
      'zoomOut',
      'fit',
    ]);
    expect(cmds[2].page).toBe(3);
    wrapper.unmount();
  });

  it('簡易表示へ倒れた後は、文書変更が fallback iframe の srcdoc に反映される', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    const post = vi.spyOn(win, 'postMessage');
    deliver({ type: 'editor:preview-error', message: 'boom' }, win);
    await flushPromises();

    await wrapper.setProps({ html: '<p>next</p>' });
    await flushPromises();
    const fallback = wrapper.get('iframe[title="プレビュー(簡易表示)"]')
      .element as HTMLIFrameElement;
    expect(fallback.srcdoc).toBe('<p>next</p>');
    // 倒れた後は子(vivliostyle 側)へは何も送らない。
    expect(
      post.mock.calls.every((c) => (c[0] as { type: string }).type !== 'editor:preview-doc'),
    ).toBe(true);
    wrapper.unmount();
  });

  it('空文書は自己完結化を経ずに即送る(空にするとローダーも出さない)', async () => {
    const wrapper = mount(PreviewPanel, { props: { html: '<p>doc</p>' }, attachTo: document.body });
    const win = frameWindow(wrapper);
    const post = vi.spyOn(win, 'postMessage');
    deliver({ type: 'editor:preview-ready' }, win);
    await flushPromises();
    post.mockClear();

    await wrapper.setProps({ html: '' });
    await flushPromises();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'editor:preview-doc', html: '' }),
      '*',
    );
    wrapper.unmount();
  });
});
