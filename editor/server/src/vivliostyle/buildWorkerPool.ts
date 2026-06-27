// =============================================================================
// buildWorkerPool.ts — 常駐 PDF ビルドワーカーのプール(cli 非依存・DI)
// =============================================================================
// `@vivliostyle/cli` の import は計測で ~11s。従来は `build.ts` がビルド毎に worker を spawn し
// 毎回これを払っていた。本プールは `@vivliostyle/cli` を読込済みのワーカープロセスを常駐させ、
// ジョブを使い回して import コストを 1 度きりにする。設計は `previewManager.ts` を範に取り、
// Map/Set 管理・アイドル TTL(`arm`/`unref`)・`disposeAll`・ワーカー生成の DI でブラウザ非依存に
// テストできるようにする。実プロセス版(`ForkedBuildWorker`)は `buildWorkerServer.ts` 側。
//
// ハング隔離は維持する: ワーカーは別プロセスなので親サーバの応答性は保たれ、ジョブが timeout を
// 超えたら当該ワーカーを SIGKILL して除去し、現行と同じエラーで reject する。

/** PDF 生成失敗時に投げる Error の前置き(`build.ts` と同一メッセージ)。 */
const PDF_BUILD_FAILED = 'PDFの生成に失敗しました';

/** timeout を build エラーと区別するための内部 sentinel。 */
class BuildTimeoutError extends Error {}

/**
 * 1 件のビルドを実行できる常駐ワーカーの抽象(プールを cli/プロセス非依存に保つ)。
 * `run` は 1 度に 1 ジョブのみ呼ばれる(プールが直列化する)。
 */
export interface BuildWorker {
  /** `@vivliostyle/cli` の `build()` オプションでビルドする。失敗(build エラー/異常)で reject。 */
  run(opts: unknown): Promise<void>;
  /** プロセスを即時 kill して破棄する(timeout/シャットダウン時)。 */
  kill(): void;
  /** ワーカーが異常終了/クラッシュした時に 1 度呼ばれる(プールが除去に使う)。 */
  onExit(cb: (err?: Error) => void): void;
}

/** ワーカー(= プロセス)を 1 つ起こす。テストでは偽実装を注入する。 */
export type BuildWorkerFactory = () => BuildWorker;

export interface BuildWorkerPoolOptions {
  /** 常駐ワーカーの最大数。`0` 以下なら呼び出し側がプールを使わない前提。 */
  poolSize: number;
  /** ワーカーをこのミリ秒数アイドルしたら停止して資源を解放する。 */
  idleTtlMs: number;
  /** 1 ジョブの上限時間。超過でワーカーを kill しジョブを reject する。 */
  timeoutMs: number;
  /** ワーカー生成(DI)。 */
  factory: BuildWorkerFactory;
}

/** プール内のワーカー 1 つ分の保持枠(アイドルタイマーを伴う)。 */
interface Slot {
  worker: BuildWorker;
  idleTimer?: NodeJS.Timeout;
}

/**
 * 常駐 PDF ビルドワーカーのプール。空きワーカーを再利用し、無ければ上限まで新規起動、満杯なら
 * FIFO で待機させる。各ワーカーは 1 ジョブずつ処理する(単一プロセス/ブラウザで `build()` を
 * 並行実行しない前提)。
 */
export class BuildWorkerPool {
  private readonly workers = new Set<Slot>();
  private readonly idle: Slot[] = [];
  private readonly waiters: { resolve: (slot: Slot) => void; reject: (e: Error) => void }[] = [];
  private readonly opts: BuildWorkerPoolOptions;

  constructor(opts: BuildWorkerPoolOptions) {
    this.opts = opts;
  }

  /** 1 件の PDF ビルドを実行する(旧 `runBuildWorker` と同契約)。 */
  async run(buildOptions: unknown): Promise<void> {
    const slot = await this.acquire();
    let timer: NodeJS.Timeout | undefined;
    try {
      const job = slot.worker.run(buildOptions);
      // race の敗者(timeout 勝利時)になっても後続 reject を unhandled にしない。
      job.catch(() => {});
      await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BuildTimeoutError()), this.opts.timeoutMs);
          timer.unref?.();
        }),
      ]);
      this.toIdle(slot); // 成功: ワーカーは健全 → 再利用へ
    } catch (e) {
      if (e instanceof BuildTimeoutError) {
        // ハング隔離: 当該ワーカーを kill して除去し、現行と同じメッセージで reject。
        this.discard(slot);
        throw new Error(`${PDF_BUILD_FAILED}: タイムアウト(${this.opts.timeoutMs}ms)で中断`);
      }
      // build エラー or 異常終了。健全なら idle へ戻す(異常終了は既に除去済みで no-op)。
      this.toIdle(slot);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 全ワーカーを停止する(プロセス終了時)。待機中のジョブは reject する。 */
  async disposeAll(): Promise<void> {
    for (const w of this.waiters.splice(0)) {
      w.reject(new Error(`${PDF_BUILD_FAILED}: サーバ終了中`));
    }
    for (const slot of [...this.workers]) {
      this.disarm(slot);
      slot.worker.kill();
    }
    this.workers.clear();
    this.idle.length = 0;
  }

  /** 現在のワーカー数(テスト/可観測性用)。 */
  size(): number {
    return this.workers.size;
  }

  // ── 内部 ──

  /** 空きワーカーを得る: idle 再利用 → 上限未満なら新規 → 満杯なら待機。 */
  private acquire(): Promise<Slot> {
    const reused = this.idle.pop();
    if (reused) {
      this.disarm(reused);
      return Promise.resolve(reused);
    }
    if (this.workers.size < this.opts.poolSize) {
      return Promise.resolve(this.spawn());
    }
    return new Promise<Slot>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** 新規ワーカーを起こしてプールへ登録する(異常終了 hook も張る)。 */
  private spawn(): Slot {
    const slot: Slot = { worker: this.opts.factory() };
    this.workers.add(slot);
    slot.worker.onExit((err) => this.onWorkerExit(slot, err));
    return slot;
  }

  /** 健全なワーカーを返却する: 待機者がいれば直接渡し、無ければ idle 化して TTL を張る。 */
  private toIdle(slot: Slot): void {
    if (!this.workers.has(slot)) return; // 異常終了で除去済み
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(slot);
      return;
    }
    this.idle.push(slot);
    this.arm(slot);
  }

  /** ワーカーを kill して除去する(timeout 時)。空いた容量で待機者を満たす。 */
  private discard(slot: Slot): void {
    if (!this.workers.has(slot)) return;
    slot.worker.kill();
    this.removeFromPool(slot);
  }

  /** 異常終了/クラッシュ通知。まだ在籍していれば除去する。 */
  private onWorkerExit(slot: Slot, _err?: Error): void {
    if (this.workers.has(slot)) this.removeFromPool(slot);
  }

  /** プールから完全に外し、容量が空いたぶん待機者を新規ワーカーで満たす。 */
  private removeFromPool(slot: Slot): void {
    this.workers.delete(slot);
    const i = this.idle.indexOf(slot);
    if (i >= 0) this.idle.splice(i, 1);
    this.disarm(slot);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(this.spawn());
  }

  private arm(slot: Slot): void {
    slot.idleTimer = setTimeout(() => this.expireIdle(slot), this.opts.idleTtlMs);
    // アイドルなワーカーが単独でプロセスを生かし続けてはならない。
    slot.idleTimer.unref?.();
  }

  private disarm(slot: Slot): void {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
  }

  /** アイドル TTL 失効: idle なワーカーを停止し資源を解放する。 */
  private expireIdle(slot: Slot): void {
    const i = this.idle.indexOf(slot);
    if (i < 0) return; // もう idle でない(再取得された)
    this.idle.splice(i, 1);
    this.workers.delete(slot);
    slot.worker.kill();
  }
}
