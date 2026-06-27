import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BuildWorker,
  BuildWorkerPool,
  type BuildWorkerPoolOptions,
} from '../src/vivliostyle/buildWorkerPool.js';

// =============================================================================
// buildWorkerPool.test.ts — 常駐ワーカープールのライフサイクルを DI 偽ワーカーで検証する
// (実ブラウザ/プロセス非依存)。再利用・直列化・timeout→kill→代替・異常終了・disposeAll。
// =============================================================================

/** run() の解決/拒否、kill、onExit を外部から制御できる偽ワーカー(プロセスの代役)。 */
class FakeWorker implements BuildWorker {
  jobs: { resolve: () => void; reject: (e: Error) => void }[] = [];
  killed = false;
  private exitCbs: ((e?: Error) => void)[] = [];

  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ resolve, reject });
    });
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.rejectAll(new Error('killed')); // 実ワーカーは kill→exit で保留ジョブを reject する
  }
  onExit(cb: (e?: Error) => void): void {
    this.exitCbs.push(cb);
  }

  /** 進行中ジョブ(FIFO)を成功させる。 */
  finish(): void {
    this.jobs.shift()?.resolve();
  }
  /** 進行中ジョブを build エラーで失敗させる(ワーカー自体は健全)。 */
  fail(msg: string): void {
    this.jobs.shift()?.reject(new Error(msg));
  }
  /** プロセスクラッシュを模す: 保留ジョブを reject し onExit を発火する。 */
  crash(): void {
    this.rejectAll(new Error('exited'));
    for (const cb of this.exitCbs) cb();
  }
  private rejectAll(e: Error): void {
    const pending = this.jobs;
    this.jobs = [];
    for (const j of pending) j.reject(e);
  }
}

function makePool(over: Partial<BuildWorkerPoolOptions> = {}) {
  const created: FakeWorker[] = [];
  const factory = () => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  };
  const pool = new BuildWorkerPool({
    poolSize: 2,
    idleTtlMs: 100_000,
    timeoutMs: 100_000,
    factory,
    ...over,
  });
  return { pool, created };
}

/** acquire(microtask)→worker.run の連鎖を流し切る。 */
async function micro(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('BuildWorkerPool', () => {
  it('アイドルワーカーを再利用する(import を払い直さない)', async () => {
    const { pool, created } = makePool({ poolSize: 2 });

    const p1 = pool.run('a');
    await micro();
    expect(created).toHaveLength(1);
    expect(created[0].jobs).toHaveLength(1);

    created[0].finish();
    await p1;

    const p2 = pool.run('b');
    await micro();
    expect(created, '2 件目は新規起動せず再利用').toHaveLength(1);
    created[0].finish();
    await p2;
    expect(pool.size()).toBe(1);
  });

  it('上限到達時はジョブを直列化(FIFO)し、解放後に次へ渡す', async () => {
    const { pool, created } = makePool({ poolSize: 1 });

    const p1 = pool.run('a');
    await micro();
    const p2 = pool.run('b');
    await micro();
    // poolSize=1 なので 2 件目は待機(新規起動も dispatch もされない)。
    expect(created).toHaveLength(1);
    expect(created[0].jobs).toHaveLength(1);

    created[0].finish(); // p1 完了 → 同じワーカーへ p2 を渡す
    await p1;
    await micro();
    expect(created).toHaveLength(1);
    expect(created[0].jobs).toHaveLength(1); // 今度は b が走っている

    created[0].finish();
    await p2;
  });

  it('上限まで並行起動する', async () => {
    const { pool, created } = makePool({ poolSize: 2 });
    const p1 = pool.run('a');
    const p2 = pool.run('b');
    await micro();
    expect(created).toHaveLength(2);
    created[0].finish();
    created[1].finish();
    await Promise.all([p1, p2]);
  });

  it('build エラーは伝播しつつワーカーは健全なまま再利用される', async () => {
    const { pool, created } = makePool({ poolSize: 1 });
    const p1 = pool.run('a');
    await micro();
    created[0].fail('PDFの生成に失敗しました: 不正な入力');
    await expect(p1).rejects.toThrow('不正な入力');
    expect(created[0].killed).toBe(false);

    // 同じワーカーを再利用できる。
    const p2 = pool.run('b');
    await micro();
    expect(created).toHaveLength(1);
    created[0].finish();
    await p2;
  });

  describe('タイムアウト(ハング隔離)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('timeout でワーカーを kill・除去し、現行と同じメッセージで reject、次は代替で成功', async () => {
      const { pool, created } = makePool({ poolSize: 1, timeoutMs: 50 });

      const p1 = pool.run('a'); // 解決させない(ハングを模す)
      await micro();
      // reject される前にハンドラを張る(timer 発火→reject→検査の間で unhandled にしない)。
      const rejected = expect(p1).rejects.toThrow(
        'PDFの生成に失敗しました: タイムアウト(50ms)で中断',
      );
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(created[0].killed).toBe(true);
      expect(pool.size()).toBe(0);

      // サーバは固まらず、次のビルドは代替ワーカーで成功する。
      const p2 = pool.run('b');
      await micro();
      expect(created).toHaveLength(2);
      created[1].finish();
      await p2;
      expect(pool.size()).toBe(1);
    });
  });

  it('ワーカー異常終了(クラッシュ)はジョブを reject しプールから除去する', async () => {
    const { pool, created } = makePool({ poolSize: 1 });
    const p1 = pool.run('a');
    await micro();

    const rejected = expect(p1).rejects.toThrow();
    created[0].crash();
    await rejected;
    expect(pool.size()).toBe(0);

    // 次ジョブは新規ワーカーで処理される。
    const p2 = pool.run('b');
    await micro();
    expect(created).toHaveLength(2);
    created[1].finish();
    await p2;
  });

  it('アイドル TTL 失効でワーカーを停止し資源を解放する', async () => {
    vi.useFakeTimers();
    try {
      const { pool, created } = makePool({ poolSize: 1, idleTtlMs: 1000 });
      const p1 = pool.run('a');
      await micro();
      created[0].finish();
      await p1;
      expect(pool.size()).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(created[0].killed).toBe(true);
      expect(pool.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposeAll は全ワーカーを kill し、待機中ジョブを reject する', async () => {
    const { pool, created } = makePool({ poolSize: 1 });
    const p1 = pool.run('a');
    await micro();
    const p2 = pool.run('b'); // 待機(キュー)
    await micro();

    // reject される前にハンドラを張ってから dispose する。
    const r1 = expect(p1).rejects.toThrow(); // kill により保留ジョブが reject
    const r2 = expect(p2).rejects.toThrow('サーバ終了中'); // 待機者は reject
    await pool.disposeAll();
    await r1;
    await r2;

    expect(created[0].killed).toBe(true);
    expect(pool.size()).toBe(0);
  });
});
