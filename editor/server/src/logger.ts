// =============================================================================
// logger.ts — アプリ/HTTP ロガーと監査証跡(audit trail)
// =============================================================================
// pino による構造化ロガー。stdout 向けロガーと、永続ファイルへの監査ログを公開する。
// 監査イベントは `audit()` で記録し、任意で SQL Server へミラーする。

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config.js';

// 書き込み先を開く前に監査ログのディレクトリが存在することを保証する。
fs.mkdirSync(config.logging.dir, { recursive: true });

/** アプリ / HTTP アクセスロガー -> stdout(本番以外は pretty 出力)。 */
export const logger = pino({
  level: config.logging.level,
  ...(config.logging.pretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
    : {}),
});

/**
 * 監査ログの出力先。`sync: false` なので書き込みは非同期で、失敗は**ストリームの
 * `error` イベント**として届く。
 *
 * ここに購読者を置かないと、Node は未処理の `error` を uncaught exception へ昇格させて
 * **プロセスごと落とす**。監査ログが書けない理由(ディスク満杯・権限・出力先ごと消えた)は
 * どれもサービスを止めるほどではなく、止めれば「ログが書けない」が「業務が止まる」に
 * 化ける。よって落とさず、アプリロガー(stdout)へ出して**気付ける形**にする
 * (黙って捨てない — 監査証跡の欠落そのものは重大なので、運用が検知できる必要がある)。
 */
const auditDestination = pino.destination({
  dest: path.join(config.logging.dir, 'audit.log'),
  mkdir: true,
  sync: false,
});
auditDestination.on('error', (err: unknown) => {
  logger.error(
    { type: 'audit.write_failed', err: err instanceof Error ? err.message : String(err) },
    '監査ログを書き込めませんでした(証跡が欠落しています)',
  );
});

/** 永続的な監査証跡 -> logs/audit.log(1 行 1 JSON レコード)。 */
const auditFileLogger = pino({ level: 'info', base: undefined }, auditDestination);

export interface AuditEvent {
  /** ドット区切りのイベント名。例 'template.save'。 */
  event: string;
  outcome: 'success' | 'failure';
  /** 操作を行った主体(actor): 認証済みユーザ名。リクエストが未認証(例 local
   *  モード)の時は 'anonymous'。`actorFromReq` を参照。 */
  actor: string;
  ip?: string;
  /** 影響を受けたリソースの識別子 / 属性。生の本文(raw content)は決して含めない。 */
  resource?: Record<string, unknown>;
  /** 非機微(non-sensitive)な追加メタデータ(サイズ・件数)。 */
  detail?: Record<string, unknown>;
  error?: string;
}

/** 監査イベントを永続ファイルに記録し、stdout にもミラーする。 */
export function audit(ev: AuditEvent): void {
  const record = { type: 'audit', ...ev };
  auditFileLogger.info(record);
  logger.info(record, `audit ${ev.event} ${ev.outcome}`);
  if (config.auditToDb) void mirrorToDb(ev);
}

/**
 * 監査イベントを SQL Server の監査テーブルへベストエフォートでコピーする。
 * DB モジュールは遅延 import する(`AUDIT_DB` が on の時のみ)。これは logger↔pool の
 * import 循環を避け、`local` モードがネイティブ DB ドライバを必要としないようにするため。
 * 失敗はログに出して握り潰す(swallow) — 上のファイルログが source of truth。
 */
let dbMirror: ((ev: AuditEvent) => Promise<void>) | undefined;
async function mirrorToDb(ev: AuditEvent): Promise<void> {
  try {
    if (!dbMirror) dbMirror = (await import('./db/audit.js')).auditToDb;
    await dbMirror(ev);
  } catch (e) {
    logger.warn({ err: e }, '[audit] DB ミラー失敗（ファイルログは記録済み）');
  }
}

/** attribution(主体特定)のために Express リクエストから読む最小限の形。 */
interface AttributableRequest {
  ip?: string;
  // auth ミドルウェアが設定する。それまでは `undefined`。
  user?: { username?: string };
}

/** リクエストから監査イベントの actor + ip を導出する。 */
export function actorFromReq(req: AttributableRequest): { actor: string; ip?: string } {
  return { actor: req.user?.username ?? 'anonymous', ip: req.ip };
}

/**
 * `fn` を実行し、`event` について成功/失敗の {@link audit} イベントを発行し、
 * エラー時は rethrow する。`success`/`failure` はイベント固有のフィールド
 * (`resource` / `detail`)だけを供給する。actor/ip/outcome とエラーメッセージは
 * ここで補完する。PDF・保存・generate の各ルートで共有される
 * try/audit-success/catch/audit-failure/throw の骨格(skeleton)を集約する。
 */
export async function auditedRethrow<T>(
  req: AttributableRequest,
  event: string,
  fn: () => Promise<T>,
  hooks: {
    success: (result: T) => Pick<AuditEvent, 'resource' | 'detail'>;
    failure: () => Pick<AuditEvent, 'resource' | 'detail'>;
    failureMessage?: string;
  },
): Promise<T> {
  try {
    const result = await fn();
    audit({ event, outcome: 'success', ...actorFromReq(req), ...hooks.success(result) });
    return result;
  } catch (e) {
    audit({
      event,
      outcome: 'failure',
      ...actorFromReq(req),
      ...hooks.failure(),
      error: e instanceof Error ? e.message : (hooks.failureMessage ?? '処理に失敗しました'),
    });
    throw e;
  }
}
