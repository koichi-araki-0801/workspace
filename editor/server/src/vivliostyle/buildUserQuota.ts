// =============================================================================
// buildUserQuota.ts — PDF 出力の人ごとの上限(実行中 1・待ち 1)
// =============================================================================
// 共有の枠(`buildWorkerPool`・既定 2 台・待ち 8)は全員で使う受付制御で、誰が並んでいるかを
// 見ない。閲覧者でも呼べる `/api/build`・`/api/build/merge` を 1 人が数件まとめて投げると、
// 枠と行列が埋まり、ほかの人の PDF 出力・プロジェクトのビルド・プレビューの展開が断られ続ける。
// そこで共有の枠の手前に、人ごとの小さな受付(`BuildAdmissionGate` を 1 人 1 つ)を置く。
//
// 1 人が持てるのは実行中 1・待ち 1。待ちの 1 件は共有の行列に並ばず人ごとの受付で待つので、
// 1 人が共有の行列を 2 件以上埋めることもない。超えた要求は待たせずに 503 で断る(生成器の
// 503 と同じ形。新しいエラーの種類は足さない)。数は `run` の終わり方(成功・失敗・共有の行列で
// 断られた・時間切れ)によらず `BuildAdmissionGate.run` の finally で戻る。

import { BUILD_BUSY_USER, BUILD_BUSY_USER_MESSAGE } from '@editor/shared';
import { BuildAdmissionGate } from './buildAdmission.js';

/** 人ごとの上限を超えたときの Error(`errorHandler` が 503 と code をそのまま返す)。 */
export function buildBusyUserError(): Error {
  return Object.assign(new Error(BUILD_BUSY_USER_MESSAGE), {
    kind: 'unexpected' as const,
    code: BUILD_BUSY_USER,
    statusCode: 503,
  });
}

/**
 * 人ごとの受付の束。受付は使うときに作り、空になったら捨てる(ログイン ID の数だけ
 * 受付が溜まり続けないため)。
 */
export class PerUserBuildGate {
  private readonly gates = new Map<string, BuildAdmissionGate>();

  /** `user` の枠で `fn` を走らせる。実行中 1・待ち 1 を超えたら `fn` を呼ばずに 503 で断る。 */
  async run<T>(user: string, fn: () => Promise<T>): Promise<T> {
    let gate = this.gates.get(user);
    if (!gate) {
      gate = new BuildAdmissionGate({
        maxConcurrent: 1,
        maxQueue: 1,
        queueFullError: buildBusyUserError,
      });
      this.gates.set(user, gate);
    }
    try {
      return await gate.run(fn);
    } finally {
      if (gate.activeCount() === 0 && gate.queueLength() === 0) this.gates.delete(user);
    }
  }

  /** `user` の実行中と待ちの合計(上限と戻りを外から確かめるための口)。 */
  load(user: string): number {
    const gate = this.gates.get(user);
    return gate ? gate.activeCount() + gate.queueLength() : 0;
  }

  /** 受付を持っている人の数(空になった受付を捨てていることの確認用)。 */
  trackedUsers(): number {
    return this.gates.size;
  }
}
