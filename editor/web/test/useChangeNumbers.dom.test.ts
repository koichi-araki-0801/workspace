// =============================================================================
// useChangeNumbers.dom.test.ts — 編集画面の変更の番号(確定版との差分)の予約と計算
// =============================================================================
// worker は jsdom で起動しないので、shared の `buildHtmlDiff` を DOMParser で直に呼ぶ形へ差し替える。
// 呼び出しを数え、解決の順を入れ替えられるようにする。
import { buildHtmlDiff, type HtmlDiff } from '@editor/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_NOTIFY_MARK,
  CHANGE_RUN_MARK,
  createChangeCheckScheduler,
  useChangeNumbers,
} from '@/features/editor/useChangeNumbers';
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

  it('予約が満了して計算を始める直前に performance の目印を打つ(e2e の所要時間の始点。最後の 1 つだけ残す)', async () => {
    // performance は本物のまま(目印の記録を見る)。時計の差し替えはタイマーだけにする。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mark = vi.spyOn(performance, 'mark');
    try {
      const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(BASE) });
      n.schedule();
      n.schedule();
      await vi.advanceTimersByTimeAsync(999);
      expect(mark).not.toHaveBeenCalledWith(CHANGE_RUN_MARK);
      await vi.advanceTimersByTimeAsync(1);
      expect(mark.mock.calls.filter(([name]) => name === CHANGE_RUN_MARK)).toHaveLength(1);
      expect(performance.getEntriesByName(CHANGE_RUN_MARK, 'mark')).toHaveLength(1);
      // もう 1 回満了させても、残る目印は 1 つ(打つたびに前の目印を消す)。打った回数は 2 回。
      n.schedule();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mark.mock.calls.filter(([name]) => name === CHANGE_RUN_MARK)).toHaveLength(2);
      expect(performance.getEntriesByName(CHANGE_RUN_MARK, 'mark')).toHaveLength(1);
      n.cancel();
    } finally {
      mark.mockRestore();
      performance.clearMarks(CHANGE_RUN_MARK);
    }
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

  /** 次の 1 回の計算を止めておく。返す関数で再開する。 */
  function holdNextDiff(): () => void {
    let release: () => void = () => {};
    diffCalls.mockImplementationOnce(async (before, after) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return buildHtmlDiff(before, after, defaultHtmlParser);
    });
    return () => release();
  }

  it('計算中に 3 回予約しても worker への送信は 2 回で、最新の本文の結果になる', async () => {
    vi.useFakeTimers();
    let body = '<p class="a">1x</p><p class="b">2</p><p class="c">3</p>';
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(body) });
    const release = holdNextDiff();
    n.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(diffCalls).toHaveBeenCalledTimes(1);
    // 計算中の予約は worker へ重ねず、印だけ立てる。
    body = '<p class="a">1</p><p class="b">2</p><p class="c">3x</p>';
    for (let i = 0; i < 3; i++) {
      n.schedule();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(diffCalls).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(5000);
    // 終わったあとに最新の本文で 1 回だけ投げ直す。
    expect(diffCalls).toHaveBeenCalledTimes(2);
    expect(diffCalls.mock.calls[1][1]).toBe(doc(body));
    expect([...n.numbers.value.byKey]).toEqual([['.c#1', 1]]);
  });

  it('投げ直しの前の古い結果は当てない', async () => {
    let body = '<p class="a">1x</p><p class="b">2</p><p class="c">3</p>';
    const n = useChangeNumbers({ baseline: () => BASE, current: () => doc(body) });
    const release = holdNextDiff();
    const first = n.flush();
    body = '<p class="a">1</p><p class="b">2</p><p class="c">3x</p>';
    const second = n.flush();
    release();
    await Promise.all([first, second]);
    expect(diffCalls).toHaveBeenCalledTimes(2);
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
    // 計算中の「もう一度」の印も消す(投げ直さない)。
    diffCalls.mockClear();
    const release = holdNextDiff();
    const running = n.flush();
    void n.flush();
    n.cancel();
    release();
    await running;
    expect(diffCalls).toHaveBeenCalledTimes(1);
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

describe('createChangeCheckScheduler(本文が変わった変更だけを差分の予約へ通す)', () => {
  /** canvas の保存内容の写し。`useTemplateEditor` は本文を `getBodyHtml()`、CSS を `getCss()` で読む。 */
  function setup(baseline: string | null = '<p class="a">1</p>') {
    const canvas = { html: '<body><p class="a">1</p></body>', css: '.a{color:red}' };
    const readBody = vi.fn(() => canvas.html);
    const schedule = vi.fn();
    const check = createChangeCheckScheduler({ readBody, baseline: () => baseline, schedule });
    check.reset();
    readBody.mockClear();
    return { canvas, readBody, schedule, check };
  }

  it('CSS だけの変更では予約しない', async () => {
    vi.useFakeTimers();
    const { canvas, schedule, check } = setup();
    canvas.css = '.a{color:blue}';
    check.notify();
    await vi.advanceTimersByTimeAsync(1000);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('本文の変更は 300ms 後に 1 回だけ予約し、続く通知は待ちを延ばす', async () => {
    vi.useFakeTimers();
    const { canvas, readBody, schedule, check } = setup();
    canvas.html = '<body><p class="a">2</p></body>';
    check.notify();
    await vi.advanceTimersByTimeAsync(200);
    check.notify();
    check.notify();
    await vi.advanceTimersByTimeAsync(299);
    expect(schedule).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    // 本文の直列化は待ちのあとの 1 回だけで、読んだ本文を差分の計算へ渡せる。
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(check.lastBody()).toBe(canvas.html);
    // 同じ本文のままの通知(選択の状態などで発火したもの)は再び予約しない。
    check.notify();
    await vi.advanceTimersByTimeAsync(1000);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('baseline が null なら何もしない(本文も読まない)', async () => {
    vi.useFakeTimers();
    const { canvas, readBody, schedule, check } = setup(null);
    canvas.html = '<body><p class="a">2</p></body>';
    check.notify();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readBody).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('通知のたびに performance の目印を打ち、残すのは最後の 1 つだけ(e2e が通知の時刻を読む)', () => {
    const mark = vi.spyOn(performance, 'mark');
    try {
      const { check } = setup();
      check.notify();
      check.notify();
      expect(mark.mock.calls.map(([name]) => name)).toEqual([
        CHANGE_NOTIFY_MARK,
        CHANGE_NOTIFY_MARK,
      ]);
      // 打ちっぱなしにすると長い編集で目印が溜まるので、前の目印は消してから打つ。
      expect(performance.getEntriesByName(CHANGE_NOTIFY_MARK, 'mark')).toHaveLength(1);
      check.cancel();
    } finally {
      mark.mockRestore();
      performance.clearMarks(CHANGE_NOTIFY_MARK);
    }
  });

  it('onRead を渡すと、待ちのあとに読んだ本文を同じ 1 回の読み出しで渡す(本文が同じでも・baseline が null でも)', async () => {
    vi.useFakeTimers();
    for (const baseline of ['<p class="a">1</p>', null]) {
      const canvas = { html: '<body><p class="a">1</p></body>' };
      const readBody = vi.fn(() => canvas.html);
      const onRead = vi.fn();
      const schedule = vi.fn();
      const check = createChangeCheckScheduler({
        readBody,
        baseline: () => baseline,
        schedule,
        onRead,
      });
      check.reset();
      readBody.mockClear();
      check.notify();
      check.notify();
      await vi.advanceTimersByTimeAsync(300);
      // 2 回の通知でも、読み出しは待ちのあとの 1 回で、その本文を onRead へ渡す。
      expect(readBody).toHaveBeenCalledTimes(1);
      expect(onRead).toHaveBeenCalledExactlyOnceWith(canvas.html);
      expect(schedule).not.toHaveBeenCalled();
    }
  });

  it('wantsRead が false の間は、番号を出さない経路で本文を読まず、onRead も呼ばない', async () => {
    vi.useFakeTimers();
    const readBody = vi.fn(() => '<body></body>');
    const onRead = vi.fn();
    let wants = false;
    const check = createChangeCheckScheduler({
      readBody,
      baseline: () => null,
      schedule: vi.fn(),
      onRead,
      wantsRead: () => wants,
    });
    check.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(readBody).not.toHaveBeenCalled();
    // 通知の時点で要らなければ待ちも張らない(あとで要るようになっても読まない)。次の通知から読む。
    check.notify();
    wants = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(readBody).not.toHaveBeenCalled();
    check.notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(onRead).toHaveBeenCalledExactlyOnceWith('<body></body>');
  });

  it('baseline が null の通知では目印を打たない', () => {
    const mark = vi.spyOn(performance, 'mark');
    try {
      setup(null).check.notify();
      expect(mark).not.toHaveBeenCalled();
    } finally {
      mark.mockRestore();
    }
  });

  it('cancel は待っている振り分けを捨てる', async () => {
    vi.useFakeTimers();
    const { canvas, schedule, check } = setup();
    canvas.html = '<body><p class="a">2</p></body>';
    check.notify();
    check.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(schedule).not.toHaveBeenCalled();
  });
});
