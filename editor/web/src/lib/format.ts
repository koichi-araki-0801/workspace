// =============================================================================
// format.ts — 各 feature の view-model で共有する表示用フォーマッタ
// =============================================================================

import { formatSubmittedAt } from '@editor/shared';

/** ローカライズした日時。空値は em dash を返す。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP');
}

/** "2024/07/10 11:42" 形式のコンパクトなゼロ埋め日時(秒なし)。 */
export function formatDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatSubmittedAt(iso);
}

/** ファイル名向けの "20240710" 形式の日付。ローカル時刻で数える(`toISOString` は UTC の
 *  日付になり、日本時間の 0:00〜8:59 は前日になる)。 */
export function formatYmdCompact(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 比較対象の版ラベル: 確定版は "日時・編集者"、現行版(原本)は `timestamp` を持たないので
 *  `user`(="現行版") だけを見せる。比較テーブル行とドロップダウンで共用する。 */
export function versionLabel(v: { timestamp: string; user: string }): string {
  return v.timestamp ? `${formatDateTimeShort(v.timestamp)}・${v.user}` : v.user;
}
