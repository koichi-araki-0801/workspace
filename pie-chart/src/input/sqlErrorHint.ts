// =============================================================================
// input/sqlErrorHint.ts — DB のエラーに付ける日本語の説明
// =============================================================================
// msnodesqlv8 のエラー文は日本語が化けることがある。6.0.0 ではクエリ中のエラー(THROW・タイムアウト)は
// 正しく読めるが、接続の失敗は日本語の各文字が `?` に置き換わって届く(LocalDB で実測)。化けた文字は
// JS 側で戻せないので、壊れない SQLSTATE とエラー番号から説明を引く。原文は ASCII だけのときに
// 限って出し、ASCII 以外を含むものは正しく読めた日本語でも出さない(`isGarbledDriverText`)。
// =============================================================================

/** エラー番号(SQL Server のメッセージ番号)ごとの説明。SQLSTATE の説明より優先する。 */
const CODE_HINTS = new Map<number, string>([
  [
    2812,
    'ストアドが見つかりません。ストアド名(PIE_DB_PROC)と、実行する Windows アカウントの権限を確認してください',
  ],
  [
    201,
    'ストアドに必要なパラメータを渡せていません。パラメータ名(src/input/sprocArgs.ts の SPROC_PARAM_NAMES)を確認してください',
  ],
  [
    8144,
    'ストアドに渡すパラメータが多すぎます。パラメータ名(src/input/sprocArgs.ts の SPROC_PARAM_NAMES)を確認してください',
  ],
  [
    8145,
    'ストアドに無いパラメータを渡しています。パラメータ名(src/input/sprocArgs.ts の SPROC_PARAM_NAMES)を確認してください',
  ],
  [
    229,
    '権限がありません。実行する Windows アカウントにストアドの EXECUTE 権限があるか確認してください',
  ],
  [
    4060,
    'データベースを開けません。DB 名(--db-name)と、実行する Windows アカウントのアクセス権を確認してください',
  ],
  [
    18456,
    'ログインに失敗しました。実行する Windows アカウントが SQL Server にログインできるか確認してください',
  ],
]);

/** ストアドが THROW / RAISERROR で自分で投げるエラーの番号の下限。 */
const USER_ERROR_MIN = 50000;

/** SQLSTATE ごとの説明。 */
const SQLSTATE_HINTS = new Map<string, string>([
  [
    '08001',
    'サーバに接続できません。サーバ名(--db-server)、ネットワーク、SQL Server が動いているかを確認してください',
  ],
  ['08S01', 'サーバとの通信が切れました。ネットワークを確認して、やり直してください'],
  [
    '28000',
    'ログインに失敗しました。実行する Windows アカウントが SQL Server にログインできるか確認してください',
  ],
  [
    'IM002',
    'ODBC ドライバが見つかりません。ODBC Driver 17(または 18)for SQL Server が入っているか確認してください(DB_ODBC_DRIVER)',
  ],
  ['HYT00', '時間内に終わりませんでした。サーバの状態を確認して、やり直してください'],
  // 6.0.0 は `timeoutMs` の打ち切りをドライバ側の取り消し(HY008)として返す。
  [
    'HY008',
    'ストアドが時間内に終わらなかったため取り消しました。ストアドの処理時間か、上限(PIE_DB_QUERY_TIMEOUT_S)を確認してください',
  ],
]);

/** SQLSTATE とエラー番号に対応する日本語の説明。知らない組み合わせは undefined。 */
export function sqlErrorHint(sqlstate?: string, code?: number): string | undefined {
  if (code !== undefined) {
    const byCode = CODE_HINTS.get(code);
    if (byCode) return byCode;
    if (code >= USER_ERROR_MIN) {
      return 'ストアドがエラーを返しました。ストアドの中の条件(ファンドコード・基準日・グラフ種別)を確認してください';
    }
  }
  return sqlstate ? SQLSTATE_HINTS.get(sqlstate) : undefined;
}

/**
 * ドライバのエラー文を原文のまま出せないか。印字できる ASCII 以外を含むか、`?` が 4 つ以上続けば
 * 出さない。後者は 6.0.0 の接続失敗で日本語の文字が `?` に置き換わった形で、実測の最短は 4 つ
 * (日本語 4 文字の語)。英文の原文に入りうる `'??'` のような短い連続は化けとみなさない。
 */
export function isGarbledDriverText(text: string): boolean {
  return /[^\x20-\x7e]|\?{4,}/.test(text);
}
