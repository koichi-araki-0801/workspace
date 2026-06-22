// =============================================================================
// format.ts — 各 feature の view-model で共有する表示用フォーマッタ
// =============================================================================

/** ローカライズした日時。空値は em dash を返す。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP');
}

/** "2024/07/10 11:42" 形式のコンパクトなゼロ埋め日時(秒なし)。 */
export function formatDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 比較対象の版ラベル: 確定版は "日時・編集者"、現行版(原本)は `timestamp` を持たないので
 *  `user`(="現行版") だけを見せる。比較テーブル行とドロップダウンで共用する。 */
export function versionLabel(v: { timestamp: string; user: string }): string {
  return v.timestamp ? `${formatDateTimeShort(v.timestamp)}・${v.user}` : v.user;
}
