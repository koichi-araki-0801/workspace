// =============================================================================
// previewHostBoot.test.ts — ビューアホストのブートスクリプトの文書の番号(偽の Vivliostyle で動かす)
// =============================================================================
// ブートスクリプトの文字列をそのまま評価し、`Vivliostyle.CoreViewer` を偽物に差し替えて、子が
// 親へ送る通知の番号を見る。core の `CoreViewer` は `cleanup` を持たず、文書を読み直しても前の
// viewer のリスナーは外れない(2026-10-29 にバンドルで確認)。前の viewer の通知が新しい文書の
// 番号で送られないことと、エラーの通知にも番号が載ることを固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_SCRIPT } from '../src/vivliostyle/previewHost.js';

type Msg = { type: string; seq?: unknown; [k: string]: unknown };
type Listener = (e?: unknown) => void;

class FakeViewer {
  static all: FakeViewer[] = [];
  static throwNext = false;
  readonly listeners: Record<string, Listener> = {};
  readyState = 'loading';
  readonly viewport: unknown;
  constructor(opts: { viewportElement: unknown }) {
    this.viewport = opts.viewportElement;
    if (FakeViewer.throwNext) {
      FakeViewer.throwNext = false;
      throw new Error('組版の初期化に失敗');
    }
    FakeViewer.all.push(this);
  }
  addListener(type: string, fn: Listener) {
    this.listeners[type] = fn;
  }
  loadDocument() {}
  setOptions() {}
  getPageSizes() {
    return [{ width: 400, height: 600 }];
  }
  navigateToPage() {}
}

/** ブートスクリプトを偽の window・document の上で起こす。 */
function bootHost(opts: { withViewer?: boolean; revokeThrows?: boolean } = {}) {
  const sent: Msg[] = [];
  const parent = { postMessage: (m: Msg) => sent.push(m) };
  const winListeners: Record<string, (e: unknown) => void> = {};
  type Node = { tag: string; className: string };
  const vp = {
    children: [] as Node[],
    set innerHTML(_v: string) {
      this.children = [];
    },
    appendChild(n: Node) {
      this.children.push(n);
      return n;
    },
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const win = {
    parent,
    innerWidth: 800,
    innerHeight: 600,
    Vivliostyle:
      opts.withViewer === false
        ? undefined
        : {
            CoreViewer: FakeViewer,
            PageViewMode: { SINGLE_PAGE: 'single' },
            ReadyState: { COMPLETE: 'complete' },
            Navigation: {},
          },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      winListeners[type] = fn;
    },
  };
  const doc = {
    getElementById: () => vp,
    createElement: (tag: string): Node => ({ tag, className: '' }),
  };
  const url = {
    createObjectURL: () => 'blob:doc',
    revokeObjectURL() {
      if (opts.revokeThrows) throw new Error('revoke に失敗');
    },
  };
  new Function('window', 'document', 'URL', 'Blob', 'requestAnimationFrame', BOOT_SCRIPT)(
    win,
    doc,
    url,
    class {},
    () => 0,
  );
  const sendDoc = (seq: number) =>
    winListeners.message?.({
      source: parent,
      data: { type: 'editor:preview-doc', html: '<p>x</p>', seq },
    });
  const of = (type: string) => sent.filter((m) => m.type === type);
  return { sent, sendDoc, of, vp };
}

beforeEach(() => {
  FakeViewer.all = [];
  FakeViewer.throwNext = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ブートスクリプトの文書の番号', () => {
  it('文書を読み直したあと、前の viewer の nav・readystatechange は通知を送らない', () => {
    const host = bootHost();
    host.sendDoc(1);
    host.sendDoc(2);
    const [old, cur] = FakeViewer.all;
    if (!old || !cur) throw new Error('viewer が 2 つ作られていない');
    const before = host.sent.length;
    old.listeners.nav?.({ epage: 2, epageCount: 9, first: false, last: true });
    old.readyState = 'complete';
    old.listeners.readystatechange?.();
    expect(host.sent.slice(before)).toEqual([]);
    // いまの viewer の通知は、いまの文書の番号で送る。
    cur.readyState = 'complete';
    cur.listeners.readystatechange?.();
    const last = host.of('editor:preview-state').at(-1);
    expect(last?.seq).toBe(2);
    expect(last?.state).toMatchObject({ ready: true });
  });

  it('組版の失敗の通知(猶予のあとの error・読み込みの例外)にも文書の番号を載せる', () => {
    vi.useFakeTimers();
    const host = bootHost();
    host.sendDoc(3);
    FakeViewer.all[0]?.listeners.error?.({ content: { messages: ['画像が無い'] } });
    vi.advanceTimersByTime(3000);
    expect(host.of('editor:preview-error')).toEqual([
      { type: 'editor:preview-error', message: '画像が無い', seq: 3 },
    ]);
    FakeViewer.throwNext = true;
    host.sendDoc(4);
    expect(host.of('editor:preview-error').at(-1)).toMatchObject({ seq: 4 });
  });

  it('前の viewer の error は、文書を読み直したあとに届いても通知しない', () => {
    vi.useFakeTimers();
    const host = bootHost();
    host.sendDoc(5);
    host.sendDoc(6);
    FakeViewer.all[0]?.listeners.error?.({ content: { messages: ['前の文書'] } });
    vi.advanceTimersByTime(3000);
    expect(host.of('editor:preview-error')).toEqual([]);
  });

  it('バンドルが無いときのエラーは、文書を受ける前の番号 0 で送る', () => {
    const host = bootHost({ withViewer: false });
    expect(host.of('editor:preview-error')).toEqual([
      { type: 'editor:preview-error', message: 'vivliostyle bundle unavailable', seq: 0 },
    ]);
  });

  it('前の viewer の error が読み直しの前に届き、猶予が読み直しの後に満了しても通知しない', () => {
    vi.useFakeTimers();
    const host = bootHost();
    host.sendDoc(7);
    FakeViewer.all[0]?.listeners.error?.({ content: { messages: ['前の文書'] } });
    vi.advanceTimersByTime(1000);
    host.sendDoc(8);
    vi.advanceTimersByTime(3000);
    expect(host.of('editor:preview-error')).toEqual([]);
  });

  it('読み込みの最初で失敗しても、その文書の番号でエラーを送る', () => {
    const host = bootHost({ revokeThrows: true });
    host.sendDoc(9);
    // 2 回目の読み込みは前の blob URL を外すところで投げる。
    host.sendDoc(10);
    expect(host.of('editor:preview-error').at(-1)).toMatchObject({ seq: 10 });
  });

  it('viewer は文書ごとに作り直した描画先へ描く(前の viewer は外した要素へ描く)', () => {
    const host = bootHost();
    host.sendDoc(11);
    host.sendDoc(12);
    const [old, cur] = FakeViewer.all;
    expect(old?.viewport).not.toBe(host.vp);
    expect(cur?.viewport).not.toBe(old?.viewport);
    expect(host.vp.children).toEqual([cur?.viewport]);
  });

  it('読み込みの最初で失敗しても、前の viewer の通知と猶予のタイマーは止まる', () => {
    vi.useFakeTimers();
    const host = bootHost({ revokeThrows: true });
    host.sendDoc(13);
    const [old] = FakeViewer.all;
    old?.listeners.error?.({ content: { messages: ['前の文書'] } });
    host.sendDoc(14);
    const before = host.sent.length;
    old?.listeners.nav?.({ epage: 1, epageCount: 3 });
    vi.advanceTimersByTime(3000);
    // 読み込みの失敗そのものの通知(番号 14)より後には、前の viewer からは何も送られない。
    expect(host.sent.slice(before)).toEqual([]);
    expect(host.of('editor:preview-error').map((m) => m.seq)).toEqual([14]);
  });
});
