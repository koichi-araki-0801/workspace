import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config.js';

// Ensure the audit log directory exists before opening the destination.
fs.mkdirSync(config.logging.dir, { recursive: true });

/** App / HTTP access logger -> stdout (pretty outside production). */
export const logger = pino({
  level: config.logging.level,
  ...(config.logging.pretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
    : {}),
});

/** Durable audit trail -> logs/audit.log (one JSON record per line). */
const auditFileLogger = pino(
  { level: 'info', base: undefined },
  pino.destination({ dest: path.join(config.logging.dir, 'audit.log'), mkdir: true, sync: false }),
);

export interface AuditEvent {
  /** Dotted event name, e.g. 'template.save'. */
  event: string;
  outcome: 'success' | 'failure';
  /** Who performed the action (currently 'anonymous' until auth lands). */
  actor: string;
  ip?: string;
  /** Identifiers / attributes of the affected resource — never raw content. */
  resource?: Record<string, unknown>;
  /** Extra non-sensitive metadata (sizes, counts). */
  detail?: Record<string, unknown>;
  error?: string;
}

/** Record an audit event to the durable file and mirror it to stdout. */
export function audit(ev: AuditEvent): void {
  const record = { type: 'audit', ...ev };
  auditFileLogger.info(record);
  logger.info(record, `audit ${ev.event} ${ev.outcome}`);
  if (config.auditToDb) void mirrorToDb(ev);
}

/**
 * Best-effort copy of the audit event into the SQL Server audit table. The DB
 * module is imported lazily (only when AUDIT_DB is on) to avoid a logger↔pool
 * import cycle and to keep `local` mode free of the native DB driver. Any
 * failure is logged and swallowed — the file log above is the source of truth.
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

/** Minimal shape we read off the Express request for attribution. */
interface AttributableRequest {
  ip?: string;
  // Populated by auth middleware; undefined until then.
  user?: { username?: string };
}

/** Derive the actor + ip for an audit event from the request. */
export function actorFromReq(req: AttributableRequest): { actor: string; ip?: string } {
  return { actor: req.user?.username ?? 'anonymous', ip: req.ip };
}
