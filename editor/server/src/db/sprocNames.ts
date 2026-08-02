// =============================================================================
// sprocNames.ts — ゲートウェイ sproc 7 本(テーブル毎に 1 本)の集中レジストリ
// =============================================================================
// すべての DB アクセスはこのいずれかを経由し、先頭の `@操作` 引数でディスパッチ
// する。日本語の物理名を 1 箇所に集約しておくことで、サーバの他部分がハードコード
// せずに済む。名前は `server/db/sproc/*.sql` と一致させる。

const SCHEMA = 'ug01';
const PREFIX = 'Rep1_運報自動化_Editor';

const gw = (target: string): string => `[${SCHEMA}].[${PREFIX}_usp_${target}]`;

/** 完全修飾のゲートウェイ sproc 名。 */
export const SP = {
  template: gw('テンプレート'),
  user: gw('ユーザー'),
  session: gw('セッション'),
  part: gw('パーツ'),
  sample: gw('サンプルデータ'),
  audit: gw('監査ログ'),
  // 注記文言のマスタ(仮組)。パーツ単位の作業メモ(noteRepo/notesFile)とは別物。
  noteMaster: gw('注記マスタ'),
} as const;
