// =============================================================================
// sprocNames.ts — ゲートウェイ sproc 8 本(テーブル毎に 1 本 + Rep1 のシリーズ参照)の集中レジストリ
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
  // 作成タブのシリーズから作成の素(Rep1 のファンド属性を読む)。
  series: gw('シリーズ'),
} as const;

/** ゲートウェイ sproc の第 1 引数 `@操作` の値。`server/db/sproc/<キー>.sql` の分岐と一致させる。 */
export const OP = {
  template: { fundList: 'ファンド一覧', companyList: '委託会社一覧' },
  user: {
    list: '一覧',
    create: '作成',
    update: '更新',
    resetPassword: 'PWリセット',
    getCredentials: '認証情報取得',
    initPassword: 'PW初期化',
  },
  session: { create: '作成', get: '取得', revoke: '失効', revokeAll: '全失効', purge: '掃除' },
  part: { classOptions: '分類候補', list: '一覧' },
  sample: { commonList: '共通一覧' },
  audit: { insert: '登録' },
  noteMaster: { get: '取得', reflect: '反映' },
  series: { list: '一覧' },
} as const;
