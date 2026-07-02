// =============================================================================
// useIframeAutoFit.test.ts — srcdoc iframe 自動フィット composable の単体テスト (vitest)
// =============================================================================
// jsdom は `ResizeObserver` を実装せず、iframe のレイアウト(scrollHeight)も計算しないため、
// 疑似 iframe と疑似 ResizeObserver を注入して「高さ反映・監視登録・unmount 解放」を検証する。
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { useIframeAutoFit } from '@/lib/useIframeAutoFit';

// 疑似 ResizeObserver。observe/disconnect の呼び出しだけ記録する。
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();
class FakeResizeObserver {
  observe = observeSpy;
  disconnect = disconnectSpy;
  unobserve = vi.fn();
}

afterEach(() => vi.restoreAllMocks());

/** contentDocument.body.scrollHeight と style を持つ疑似 iframe を @load イベント化する。 */
function loadEvent(scrollHeight: number) {
  const iframe = {
    contentDocument: { body: { scrollHeight } },
    style: { height: '' } as { height: string },
  };
  return { target: iframe } as unknown as Event;
}

/** composable をコンポーネント内で動かし、返り値と unmount を扱えるようにする。 */
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

describe('useIframeAutoFit', () => {
  it('scrollHeight を高さに反映し、iframe を 1 度だけ監視登録する', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { wrapper, api } = mountHost();
    const ev = loadEvent(120);

    api.fitFrame(ev);
    const iframe = ev.target as unknown as { style: { height: string } };
    // 高さは scrollHeight + 4px。
    expect(iframe.style.height).toBe('124px');
    expect(observeSpy).toHaveBeenCalledTimes(1);

    // 同じ iframe の再 load では二重監視しない。
    api.fitFrame(ev);
    expect(observeSpy).toHaveBeenCalledTimes(1);

    // unmount で監視を解放する。
    wrapper.unmount();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('scrollHeight が 0 なら高さを触らない', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { api } = mountHost();
    const ev = loadEvent(0);
    api.fitFrame(ev);
    const iframe = ev.target as unknown as { style: { height: string } };
    expect(iframe.style.height).toBe('');
  });
});
