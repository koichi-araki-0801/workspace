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
import { isReactive, reactive, ref } from 'vue';
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
  it('既定のフレームは allow-scripts のみ・ホストページを src に持つ', async () => {
    const p = renderJinjaIsolated('<p>{{ x }}</p>', {});
    const f = document.querySelector('iframe');
    expect(f?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f?.getAttribute('src')).toBe('/api/render-host/index.html');

    // jsdom はホストページを取りに行かないので READY は来ない = 既定の boot 期限で error。
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).error).toBeTruthy();
  });

  // ── realm を要求ごとに閉じる ──
  // 隔離の単位は iframe ではなく realm。使い回すと、ある要求で走った JS が realm 上の状態を
  // 書き換えて以後の応答を偽装できる。承認画面は申請者の本文 → 現行版の順に描画するため、
  // これは差分の「変更前」側を申請者が決められることに直結する。
  it('要求ごとにフレームを作り、終わったら必ず捨てる', async () => {
    expect(document.querySelectorAll('iframe')).toHaveLength(0);

    const first = renderJinjaIsolated('<p>a</p>', {});
    const frameA = document.querySelector('iframe');
    expect(frameA).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    // 応答後にフレームが残っていると realm が次の要求へ持ち越される。
    expect(document.querySelectorAll('iframe')).toHaveLength(0);

    const second = renderJinjaIsolated('<p>b</p>', {});
    const frameB = document.querySelector('iframe');
    expect(frameB).not.toBe(frameA);
    await vi.advanceTimersByTimeAsync(15_000);
    await second;
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('並行する要求は互いに別のフレームを使う', async () => {
    const both = Promise.all([
      renderJinjaIsolated('<p>a</p>', {}),
      renderJinjaIsolated('<p>b</p>', {}),
    ]);
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await both;
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });
});

// ── 差し込みデータは複製可能な形にして送る ──
// `postMessage` は structured clone を通るが **Proxy は複製できない**。画面の状態は Vue の
// `ref` / `reactive` で包まれているため、`sample.value` をそのまま渡すと `DataCloneError` に
// なる。しかもそれは同期例外なので、捕まえないと「要求は送られていないのに待ち合わせだけが
// 残る」= 利用者は期限いっぱい待たされて無関係な文言を受け取る。実際に PDF 出力がこの形で
// 壊れていた(プレビューは素の値を使うため動いていて、差が見えにくかった)。
describe('renderHostClient — 差し込みデータの受け渡し', () => {
  it('Vue の ref を渡しても素の値になって届き、描画できる', async () => {
    const plain = { fund: { code: '510037', name: 'テスト' }, rows: [{ a: 1 }] };
    const p = client.render('<p>{{ fund.name }}</p>', ref(plain).value);
    const post = vi.spyOn(childWindow(), 'postMessage');
    deliver({ type: MSG_READY }, childWindow());

    const req = sentRequests(post)[0];
    expect(req.data).toEqual(plain);
    // **Proxy でないこと**が要件。実ブラウザの postMessage は Proxy を複製できず同期例外を
    // 投げる(jsdom は複製しないので、値の一致だけでは proxy と素の値を区別できない)。
    expect(isReactive(req.data)).toBe(false);

    deliver({ type: MSG_RES, id: req.id, html: '<p>テスト</p>' }, childWindow());
    expect((await p).html).toBe('<p>テスト</p>');
  });

  it('reactive() を直に渡しても同じ', async () => {
    const p = client.render('<p>x</p>', reactive({ fund: { code: 'x' } }));
    const post = vi.spyOn(childWindow(), 'postMessage');
    deliver({ type: MSG_READY }, childWindow());

    const req = sentRequests(post)[0];
    expect(req.data).toEqual({ fund: { code: 'x' } });
    expect(isReactive(req.data)).toBe(false);
    deliver({ type: MSG_RES, id: req.id, html: 'ok' }, childWindow());
    expect((await p).html).toBe('ok');
  });

  it('循環参照は期限を待たずに理由を返す(30 秒待たせない)', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // 期限を 1 度も進めずに解決する = 待たされていない。
    const res = await client.render('<p>x</p>', cyclic);
    expect(res.html).toBe('');
    expect(res.error).toContain('差し込みデータ');
  });

  it('送信そのものが失敗したら、その場で理由を返す', async () => {
    const p = client.render('<p>x</p>', { a: 1 });
    vi.spyOn(childWindow(), 'postMessage').mockImplementation(() => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    });
    deliver({ type: MSG_READY }, childWindow());

    const res = await p;
    expect(res.html).toBe('');
    expect(res.error).toContain('要求を送れませんでした');
  });
});
