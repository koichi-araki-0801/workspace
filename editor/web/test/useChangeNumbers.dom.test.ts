// =============================================================================
// useChangeNumbers.dom.test.ts — 編集画面の変更の番号(確定版との差分)の予約と計算
// =============================================================================
// worker は jsdom で起動しないので、shared の `buildHtmlDiff` を DOMParser で直に呼ぶ形へ差し替える。
// 呼び出しを数え、解決の順を入れ替えられるようにする。
import fs from 'node:fs';
import path from 'node:path';
import { buildHtmlDiff, type HtmlDiff } from '@editor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBodyChangeGate, useChangeNumbers } from '@/features/editor/useChangeNumbers';
import { defaultHtmlParser } from '@/lib/htmlParser';

const diffCalls = vi.fn(
  async (before: string, after: string): Promise<HtmlDiff> =>
    buildHtmlDiff(before, after, defaultHtmlParser),
);
vi.mock('@/workers', () => ({
  htmlWorker: {
    buildHtmlDiff: (before: string, after: string) => diffCalls(before, after),
  },
}));

// 失敗の経路のログはテストの出力に出さない。
vi.mock('@/lib/appError', async (orig) => ({
  ...(await orig<typeof import('@/lib/appError')>()),
  logError: vi.fn(),
}));

const BASE = '<p class="a">1</p><p class="b">2</p><p class="c">3</p>';
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

beforeEach(() => {
  diffCalls.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useChangeNumbers', () => {
  it('確定版と同じなら番号は空', async () => {
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(BASE) });
    await n.flush();
    expect(diffCalls).toHaveBeenCalledTimes(1);
    expect([...n.numbers.value.byKey]).toEqual([]);
    expect(n.numbers.value.removed).toEqual([]);
  });

  it('変更・追加のパーツに紙面の上から 1 から振り、削除は removed に入る', async () => {
    const n = useChangeNumbers({
      baseline: () => BASE,
      current: () => doc('<p class="a">1x</p><p class="c">3</p><p class="d">4</p>'),
    });
    await n.flush();
    expect([...n.numbers.value.byKey]).toEqual([
      ['.a#1', 1],
      ['.d#1', 3],
    ]);
    // 削除したパーツは確定版側のキーと、先頭の文字から作った名前を持つ。
    expect(n.numbers.value.removed).toEqual([{ no: 2, key: '.b#1', name: '2' }]);
  });

  it('削除したパーツの名前は、カタログの業務名があればそれを使う', async () => {
    const n = useChangeNumbers({
      baseline: () => '<div data-part-id="greet">こんにちは</div><p class="c">3</p>',
      current: () => doc('<p class="c">3</p>'),
      nameById: () => new Map([['greet', 'ごあいさつ']]),
    });
    await n.flush();
    expect(n.numbers.value.removed).toEqual([{ no: 1, key: 'greet#1', name: 'ごあいさつ' }]);
  });

  it('baseline が null なら計算しない', async () => {
    vi.useFakeTimers();
    const n = useChangeNumbers({ baseline: () => null, current: () => doc('<p>x</p>') });
    await n.flush();
    n.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(diffCalls).not.toHaveBeenCalled();
    expect([...n.numbers.value.byKey]).toEqual([]);
    expect(n.numbers.value.removed).toEqual([]);
  });

  it('schedule を続けて呼んでも 1,000ms 後に 1 回だけ計算する', async () => {
    vi.useFakeTimers();
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(BASE) });
    n.schedule();
    await vi.advanceTimersByTimeAsync(500);
    n.schedule();
    n.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(diffCalls).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(diffCalls).toHaveBeenCalledTimes(1);
  });

  it('debounceMs に 1,000ms 未満を渡しても 1,000ms 待つ', async () => {
    vi.useFakeTimers();
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(BASE), debounceMs: 10 });
    n.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(diffCalls).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(diffCalls).toHaveBeenCalledTimes(1);
  });

  it('flush は予約を取り消してすぐ計算する', async () => {
    vi.useFakeTimers();
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(BASE) });
    n.schedule();
    await n.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(diffCalls).toHaveBeenCalledTimes(1);
  });

  it('計算中に古い結果が新しい結果を上書きしない', async () => {
    let body = '<p class="a">1x</p><p class="b">2</p><p class="c">3</p>';
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(body) });
    // 1 回目の計算を止めておき、2 回目が先に終わる形にする。
    let releaseFirst: () => void = () => {};
    diffCalls.mockImplementationOnce(async (before, after) => {
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      return buildHtmlDiff(before, after, defaultHtmlParser);
    });
    const first = n.flush();
    body = '<p class="a">1</p><p class="b">2</p><p class="c">3x</p>';
    await n.flush();
    expect([...n.numbers.value.byKey]).toEqual([['.c#1', 1]]);
    releaseFirst();
    await first;
    expect([...n.numbers.value.byKey]).toEqual([['.c#1', 1]]);
  });

  it('cancel は予約と計算中の結果を捨てる', async () => {
    vi.useFakeTimers();
    const n = useChangeNumbers({
      baseline: () => BASE,
      current: () => doc('<p class="a">1x</p><p class="b">2</p><p class="c">3</p>'),
    });
    n.schedule();
    n.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(diffCalls).not.toHaveBeenCalled();
    const pending = n.flush();
    n.cancel();
    await pending;
    expect(n.numbers.value.byKey.size).toBe(0);
  });

  it('計算に失敗したら番号を出さない(古い番号を残さない)', async () => {
    const n = useChangeNumbers({
      baseline: () => BASE,
      current: () => doc('<p class="a">1x</p><p class="b">2</p><p class="c">3</p>'),
    });
    await n.flush();
    expect(n.numbers.value.byKey.size).toBe(1);
    diffCalls.mockImplementationOnce(async () => {
      throw new Error('worker down');
    });
    await n.flush();
    expect(n.numbers.value.byKey.size).toBe(0);
  });
});

describe('createBodyChangeGate(本文が変わった変更だけを差分の予約へ通す)', () => {
  it('CSS だけの変更では schedule しない', async () => {
    vi.useFakeTimers();
    // canvas の保存内容の写し。`useTemplateEditor` は本文を `getBodyHtml()`、CSS を `getCss()` で読む。
    const canvas = { html: '<body><p class="a">1</p></body>', css: '.a{color:red}' };
    const n = useChangeNumbers({
      baseline: () => '<p class="a">1</p>',
      current: () => doc(canvas.html),
    });
    const gate = createBodyChangeGate(() => canvas.html);
    gate.reset();
    const onCanvasChange = () => {
      if (gate.changed()) n.schedule();
    };
    canvas.css = '.a{color:blue}';
    onCanvasChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(diffCalls).not.toHaveBeenCalled();

    canvas.html = '<body><p class="a">2</p></body>';
    onCanvasChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(diffCalls).toHaveBeenCalledTimes(1);

    // 同じ本文のままの変更(選択の状態などで発火した通知)は再び通さない。
    onCanvasChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(diffCalls).toHaveBeenCalledTimes(1);
  });

  it('useTemplateEditor は canvas の変更を本文の門で振り分けてから差分を予約する', () => {
    // `useTemplateEditor` は GrapesJS 一式を起こすので単体では組めない。呼び分けの形を原文で固定する。
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/features/editor/useTemplateEditor.ts'),
      'utf8',
    );
    expect(src).toMatch(/createBodyChangeGate\(\(\) => g\.getBodyHtml\(\)\)/);
    expect(src).toMatch(/if \(bodyGate\.changed\(\)\) changeNumbers\.schedule\(\)/);
    // 予約は gate の後ろでだけ呼ぶ(markChanged から直に schedule しない)。
    expect(src.match(/changeNumbers\.schedule\(\)/g)).toHaveLength(1);
  });
});
