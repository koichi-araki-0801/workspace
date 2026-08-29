// =============================================================================
// buildAdmission.ts — PDF ビルドの受付制御(同時実行数と行列長の上限だけを担う)
// =============================================================================
// `buildWorkerPool` は「常駐ワーカーの再利用」と「受付制御」を兼ねているが、
// `config.vivliostyle.build.poolSize <= 0` のフォールバック(ジョブ毎 spawn。障害調査用の
// 安全弁)はプールを通らないため、受付制御だけが丸ごと抜け落ちていた。無制限だと、
// 同時到着したリクエストの数だけ Node + Chromium が立ち上がり、単一プロセスのサーバが
// メモリごと落ちる — 安全弁が本体より危険になる。
//
// ⚠ ここでワーカー管理を再利用しない(`buildWorkerPool` を呼ばない)。フォールバックは
// 「プール機構そのものを疑うとき」に使う迂回路で、迂回先がプールに依存したら意味が消える。
// 共有するのは行列満杯の**文言だけ**で、経路によって利用者への応答を変えない。

import { BUILD_QUEUE_FULL_MESSAGE } from './buildWorkerPool.js';

export interface BuildAdmissionOptions {
  /** 同時に走らせる最大件数。`1` 未満は 1 として扱う(0 は全ビルドが永久に待つだけ)。 */
  maxConcurrent: number;
  /**
   * 待機列に並べる最大件数。超過した `run` は待たずに即 reject する。
   * 上限の無い行列は「待たせておけば資源を握り続けられる」経路そのものなので、
   * `buildWorkerPool` と同じく有限にする。
   */
  maxQueue: number;
}

/**
 * 同時実行数と行列長の上限だけを持つ最小の受付制御。`run` に渡した処理は枠を取ってから
 * 走り、終了(成功・失敗どちらでも)で枠を返す。
 *
 * ⚠ **資源の確保は `fn` の中で行うこと**(temp ディレクトリ・配信ルートへの資産配置・
 * egress ポート予約)。枠を取る前に確保すると、順番待ちのあいだも資源を握り続けるため、
 * 行列の長さがそのまま資源消費になる(`buildWorkerPool.withSlot` と同じ規律)。
 */
export class BuildAdmissionGate {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(opts: BuildAdmissionOptions) {
    // 0 以下を素通しすると誰も枠を取れず、全ビルドが timeout まで待つ「静かな全停止」に
    // なる。上限の設定ミスで停止させるより、最も保守的な 1 本ずつへ寄せる。
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
    this.maxQueue = Math.max(0, Math.floor(opts.maxQueue));
  }

  /** 枠を確保して `fn` を 1 回走らせる。行列が満杯なら `fn` を呼ばずに reject する。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 待機中の件数(上限が効いていることを外から観測するための口)。 */
  queueLength(): number {
    return this.waiters.length;
  }

  /** 実行中の件数(同上)。 */
  activeCount(): number {
    return this.active;
  }

  // ── 内部 ──

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new Error(BUILD_QUEUE_FULL_MESSAGE));
    }
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /**
   * 枠を返す。待機者が居るなら `active` を減らさずそのまま引き渡す — 一旦減らして
   * 待機者に取り直させると、その隙間に到着した新規が割り込めてしまう(順番待ちが
   * 無意味になり、待機側が飢える)。
   */
  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.active -= 1;
  }
}
