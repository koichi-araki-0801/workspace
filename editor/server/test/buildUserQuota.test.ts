// =============================================================================
// buildUserQuota.test.ts — PDF 出力の人ごとの上限(実行中 1・待ち 1)
// =============================================================================
// 共有の枠(既定 2 台・待ち 8)は全員で使う。人ごとの上限が無いと、閲覧者 1 人が数件の
// 要求で枠と行列を埋め、ほかの人の PDF 出力・プロジェクトのビルド・プレビューの展開が
// 断られ続ける。ここでは上限そのものと、どの終わり方(成功・失敗・共有の行列で断られた・
// 時間切れ)でも人ごとの数が元に戻ることを見る。
import { BUILD_BUSY_USER, BUILD_BUSY_USER_MESSAGE } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { buildBusyUserError, PerUserBuildGate } from '../src/vivliostyle/buildUserQuota.js';

/** 外から解決・拒否できる約束(実行中の 1 件を握り続ける代役)。 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('PerUserBuildGate', () => {
  it('同じ人の 3 件目は 503 / BUILD_BUSY_USER で断り、別の人は通す', async () => {
    const gate = new PerUserBuildGate();
    const first = deferred();
    const p1 = gate.run('alice', () => first.promise);
    let secondStarted = false;
    const p2 = gate.run('alice', async () => {
      secondStarted = true;
    });
    await flush();
    // 2 件目は待ちに入り、1 件目が終わるまで始まらない(実行中 1)。
    expect(secondStarted).toBe(false);
    expect(gate.load('alice')).toBe(2);

    const third = gate.run('alice', async () => 'never');
    await expect(third).rejects.toMatchObject({
      message: BUILD_BUSY_USER_MESSAGE,
      code: BUILD_BUSY_USER,
      statusCode: 503,
      kind: 'unexpected',
    });
    // 断った 1 件は数に残らない。
    expect(gate.load('alice')).toBe(2);

    // 別の人は alice の数に関係なく通る。
    await expect(gate.run('bob', async () => 'bob-ok')).resolves.toBe('bob-ok');

    first.resolve();
    await p1;
    await p2;
    expect(secondStarted).toBe(true);
    expect(gate.load('alice')).toBe(0);
    expect(gate.trackedUsers()).toBe(0);
  });

  it.each([
    [
      '共有の行列が一杯で断られた',
      () => Promise.reject(new Error('PDF生成の順番待ちが混み合っています')),
    ],
    ['展開に失敗した', () => Promise.reject(new Error('zip の展開に失敗'))],
    [
      '時間切れ',
      () => Promise.reject(new Error('PDFの生成に失敗しました: タイムアウト(1ms)で中断')),
    ],
  ])('%s ときも人ごとの数が戻る', async (_label, fail) => {
    const gate = new PerUserBuildGate();
    const blocker = deferred();
    const running = gate.run('alice', () => blocker.promise);
    const waiting = gate.run('alice', fail);
    expect(gate.load('alice')).toBe(2);
    blocker.resolve();
    await running;
    await expect(waiting).rejects.toThrow();
    expect(gate.load('alice')).toBe(0);
    expect(gate.trackedUsers()).toBe(0);
    // 戻ったので、また 2 件まで受け付ける。
    const again = deferred();
    const a = gate.run('alice', () => again.promise);
    const b = gate.run('alice', async () => {});
    expect(gate.load('alice')).toBe(2);
    again.resolve();
    await Promise.all([a, b]);
  });

  it('同期に投げる処理でも数が戻る', async () => {
    const gate = new PerUserBuildGate();
    await expect(
      gate.run('alice', () => {
        throw new Error('同期の失敗');
      }),
    ).rejects.toThrow('同期の失敗');
    expect(gate.load('alice')).toBe(0);
  });

  it('知らない人の数は 0', () => {
    expect(new PerUserBuildGate().load('nobody')).toBe(0);
  });

  it('buildBusyUserError は生成器の 503 と同じ形(errorHandler が状態と code をそのまま返す)', () => {
    const e = buildBusyUserError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ kind: 'unexpected', code: BUILD_BUSY_USER, statusCode: 503 });
  });
});
