// =============================================================================
// audit.ts — 監査イベントを SQL Server の監査テーブルへ複写(ベストエフォート副本)
// =============================================================================
// 永続的な source of truth はファイルログ (`logs/audit.log`) のまま。これは
// クエリ可能な複本にすぎない。`config.auditToDb` が有効なとき(REST デプロイ)
// だけ呼ばれる。失敗は呼び出し元 (`logger.ts` の `logger.audit`) が握り潰すので
// アプリが止まることはない。
import type { AuditEvent } from '../logger.js';
import { p, realSproc, type SprocClient } from './sproc.js';
import { SP } from './sprocNames.js';

// 監査ログの複写先。logger はグローバルで app にも request にも紐付かないので、ここだけは
// モジュール変数の差し替えになる。呼ぶのは `app.ts` の `buildApp` だけで、他所から呼ばない
// ことは `test/guardCoverage.guard.test.ts` が走査で固定する。
let sink: SprocClient = realSproc;

/** 監査ログ複写の実行面を差し込む。 */
export function setAuditSink(sproc: SprocClient): void {
  sink = sproc;
}

export async function auditToDb(ev: AuditEvent): Promise<void> {
  await sink.callSproc(SP.audit, '登録', [
    p('イベント', ev.event),
    p('結果', ev.outcome),
    p('実行者', ev.actor),
    p('IP', ev.ip),
    p('リソースJSON', ev.resource ? JSON.stringify(ev.resource) : null),
    p('詳細JSON', ev.detail ? JSON.stringify(ev.detail) : null),
    p('エラー', ev.error),
  ]);
}
