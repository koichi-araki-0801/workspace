/**
 * Mirror an audit event into the SQL Server audit table (best-effort副本).
 *
 * The durable source of truth stays the file log (`logs/audit.log`); this is a
 * queryable copy. Called only when `config.auditToDb` is on (REST deploys).
 * Failures are swallowed by the caller (`logger.audit`) so the app never stops.
 */
import type { AuditEvent } from '../logger.js';
import { callSproc, p } from './sproc.js';
import { SP } from './sprocNames.js';

export async function auditToDb(ev: AuditEvent): Promise<void> {
  await callSproc(SP.audit, '登録', [
    p('イベント', ev.event),
    p('結果', ev.outcome),
    p('実行者', ev.actor),
    p('IP', ev.ip),
    p('リソースJSON', ev.resource ? JSON.stringify(ev.resource) : null),
    p('詳細JSON', ev.detail ? JSON.stringify(ev.detail) : null),
    p('エラー', ev.error),
  ]);
}
