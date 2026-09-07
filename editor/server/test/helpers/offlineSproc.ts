// =============================================================================
// offlineSproc.ts — DB 不在を再現する sproc 実行面
// =============================================================================
// 承認の後段(注記マスタ書き戻し・ペア同期)はベストエフォートで、DB へ触れなくても承認は
// 成立する。その姿勢を固定するテストへ「必ず失敗する DB」を渡す。開発機に LocalDB が居ても
// 実 DB を触らないことがここの主眼で、`createSprocClient` を通すことで本番と同じ
// `mapSqlError` を経由した種別(`unexpected`)に揃う。
import { createSprocClient, type SprocClient } from '../../src/db/sproc.js';

export function createOfflineSproc(): SprocClient {
  return createSprocClient(async () => {
    throw Object.assign(new Error('DB 不在(テストの意図的失敗)'), { number: 40000 });
  });
}
