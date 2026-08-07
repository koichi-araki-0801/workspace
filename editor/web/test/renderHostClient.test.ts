// =============================================================================
// renderHostClient.test.ts — 隔離レンダーホストの親側クライアントの契約
// =============================================================================
// 検証する契約は 5 つ:
//   1. 発信元検証 — `event.source === iframe.contentWindow` の同一性でだけ受ける
//      (opaque オリジンの `origin` は 'null' で、他の任意の sandbox フレームとも一致するため
//      識別に使えない)。
//   2. READY 前の要求は保留し、READY 受信でまとめて子へ流す。
//   3. 応答は `id` で突き合わせる(親が採番し、子は覚えない)。
//   4. 子が沈黙する形の失敗は boot 期限で `RenderResult.error` に変える(例外にしない)。
//   5. ブート段の致命失敗(予約 id)は要求単位ではなく恒久失敗として扱う。
//
// メッセージ種別は**リテラルで**書く。定数を import すると親子で同時に改名しても気付けず、
// ここで固定したいのは「線上を流れる実際の文字列」だからである。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRenderHostClient,
  type RenderHostClient,
  renderJinjaIsolated,
} from '@/lib/renderHostClient';

const MSG_READY = 'editor:render-ready';
const MSG_REQ = 'editor:render-req';
const MSG_RES = 'editor:render-res';
const MSG_ERROR = 'editor:render-error';

/** 生成された隔離フレーム(`mount` 差し替えで掴む)。 */
let frame: HTMLIFrameElement;

/** ネットワークを触らない代用フレーム。検証に要るのは `contentWindow` の同一性だけ。 */
function mountStub(): HTMLIFrameElement {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame;
}

function childWindow(): Window {
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

/** 子へ届いた要求メッセージだけを取り出す。 */
function sentRequests(
  post: ReturnType<typeof vi.spyOn>,
): { type: string; id: number; template: string; data: unknown }[] {
  return post.mock.calls.map(
    (c) => c[0] as { type: string; id: number; template: string; data: unknown },
  );
}

let client: RenderHostClient;

beforeEach(() => {
  vi.useFakeTimers();
  // 失敗経路は logError が console.error を呼ぶ。テスト出力を汚さないよう黙らせる。
  vi.spyOn(console, 'error').mockImplementation(() => {});
  client = createRenderHostClient({ bootTimeoutMs: 1000, callTimeoutMs: 5000, mount: mountStub });
});

afterEach(() => {
  client.dispose();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('renderHostClient — 発信元検証', () => {
  it('contentWindow 以外を発信元とする READY は無視する', () => {
    void client.render('<p>{{ x }}</p>', { x: 1 });
    const post = vi.spyOn(childWindow(), 'postMessage');

    // 親自身・null を装った READY。source 同一性で落ちるので要求は流れない。
    deliver({ type: MSG_READY }, window);
    deliver({ type: MSG_READY }, null);
    expect(post).not.toHaveBeenCalled();

    deliver({ type: MSG_READY }, childWindow());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('contentWindow 以外を発信元とする応答は要求を解決しない', async () => {
    const p = client.render('<p>a</p>', {});
    deliver({ type: MSG_READY }, childWindow());
    // 別フレームを騙った応答。無視されるので、解決するのは自前の期限切れだけ。
    deliver({ type: MSG_RES, id: 1, html: '<p>偽装</p>' }, window);

    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.html).toBe('');
    expect(r.error).toBeTruthy();
  });
});

describe('renderHostClient — 保留と id 対応付け', () => {
  it('READY 前の要求を保留し、READY で受け付け順に流す', () => {
    void client.render('<p>1</p>', { n: 1 });
    void client.render('<p>2</p>', { n: 2 });
    const post = vi.spyOn(childWindow(), 'postMessage');

    expect(post).not.toHaveBeenCalled();
    deliver({ type: MSG_READY }, childWindow());

    const reqs = sentRequests(post);
    expect(reqs.map((r) => [r.type, r.id, r.template])).toEqual([
      [MSG_REQ, 1, '<p>1</p>'],
      [MSG_REQ, 2, '<p>2</p>'],
    ]);
    // `targetOrigin` は opaque オリジンの子には '*' しか指定できない。
    expect(post.mock.calls[0][1]).toBe('*');
  });

  it('READY 後の要求は即座に子へ渡る', () => {
    void client.render('<p>0</p>', {});
    deliver({ type: MSG_READY }, childWindow());
    const post = vi.spyOn(childWindow(), 'postMessage');

    void client.render('<p>3</p>', { n: 3 });
    expect(sentRequests(post).map((r) => [r.id, r.template])).toEqual([[2, '<p>3</p>']]);
  });

  it('応答は id で対応する Promise だけを解決する(順不同でも取り違えない)', async () => {
    const first = client.render('<p>1</p>', {});
    const second = client.render('<p>2</p>', {});
    deliver({ type: MSG_READY }, childWindow());

    // わざと逆順で返す。id が唯一の対応付けなので順序は関係ない。
    deliver({ type: MSG_RES, id: 2, html: '<p>二番</p>' }, childWindow());
    deliver({ type: MSG_RES, id: 1, html: '<p>一番</p>' }, childWindow());

    expect(await first).toEqual({ html: '<p>一番</p>', error: null });
    expect(await second).toEqual({ html: '<p>二番</p>', error: null });
  });

  it('要求単位の ERROR は例外でなく error 文字列として返る', async () => {
    const p = client.render('{% if %}', {});
    deliver({ type: MSG_READY }, childWindow());
    deliver({ type: MSG_ERROR, id: 1, error: 'unexpected token' }, childWindow());

    expect(await p).toEqual({ html: '', error: 'unexpected token' });
  });

  it('未知の id・型不明のメッセージは黙って捨てる', async () => {
    const p = client.render('<p>1</p>', {});
    deliver({ type: MSG_READY }, childWindow());
    deliver({ type: MSG_RES, id: 99, html: '<p>他人の応答</p>' }, childWindow());
    deliver(null, childWindow());
    deliver({ nothing: true }, childWindow());
    deliver({ type: MSG_RES, id: '1', html: '<p>文字列 id</p>' }, childWindow());

    // 正しい応答だけが効く。
    deliver({ type: MSG_RES, id: 1, html: '<p>本物</p>' }, childWindow());
    expect(await p).toEqual({ html: '<p>本物</p>', error: null });
  });
});

describe('renderHostClient — 失敗の扱い', () => {
  it('READY が来ないまま boot 期限が切れると error を返す', async () => {
    const p = client.render('<p>x</p>', {});
    await vi.advanceTimersByTimeAsync(1000);

    const r = await p;
    expect(r.html).toBe('');
    expect(r.error).toMatch(/描画環境/);
  });

  it('boot 失敗後の要求は待たずに同じ error を返す(期限分を積み重ねない)', async () => {
    const first = client.render('<p>x</p>', {});
    await vi.advanceTimersByTimeAsync(1000);
    await first;

    // タイマーを一切進めずに解決する = 恒久失敗として即返している。
    const r = await client.render('<p>y</p>', {});
    expect(r.error).toMatch(/描画環境/);
  });

  it('ブート段の致命失敗(予約 id 0)は保留中の全要求を落とす', async () => {
    const first = client.render('<p>1</p>', {});
    const second = client.render('<p>2</p>', {});
    deliver({ type: MSG_ERROR, id: 0, error: 'nunjucks bundle unavailable' }, childWindow());

    expect((await first).error).toMatch(/描画環境/);
    expect((await second).error).toMatch(/描画環境/);
  });

  it('応答が返らない要求は呼び出し期限で error になる', async () => {
    const p = client.render('<p>x</p>', {});
    deliver({ type: MSG_READY }, childWindow());
    await vi.advanceTimersByTimeAsync(5000);

    const r = await p;
    expect(r.html).toBe('');
    expect(r.error).toBeTruthy();
  });

  it('dispose 後はフレームも window リスナも残さない', async () => {
    const p = client.render('<p>x</p>', {});
    const win = childWindow();
    client.dispose();

    expect((await p).error).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    // リスナが残っていれば、この READY で「準備完了」に戻ってしまう。
    deliver({ type: MSG_READY }, win);
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('renderHostClient — フレームの生成', () => {
  it('最初の render まで iframe を作らない(開かない画面で読みに行かない)', () => {
    const lazy = createRenderHostClient({ mount: mountStub });
    expect(document.querySelector('iframe')).toBeNull();
    void lazy.render('<p>x</p>', {});
    expect(document.querySelector('iframe')).not.toBeNull();
    lazy.dispose();
  });

  it('2 回目以降の render は同じフレームを共有する', () => {
    void client.render('<p>1</p>', {});
    void client.render('<p>2</p>', {});
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  // 既定の `mount` が置くフレームの属性は隔離そのもの。`allow-same-origin` が付いた瞬間に
  // sandbox は無効化と等価になり、子の JS が親オリジンの DOM と cookie へ到達する。
  // ここは共有シングルトン(`renderJinjaIsolated`)を触るので、この describe の最後に置く。
  it('既定のフレームは allow-scripts のみ・ホストページを src に持つ', async () => {
    const p = renderJinjaIsolated('<p>{{ x }}</p>', {});
    const f = document.querySelector('iframe');
    expect(f?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f?.getAttribute('src')).toBe('/api/render-host/index.html');

    // jsdom はホストページを取りに行かないので READY は来ない = 既定の boot 期限で error。
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).error).toBeTruthy();
  });
});
