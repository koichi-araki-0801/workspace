// =============================================================================
// input/sqlErrorHint.ts — DB のエラーに付ける日本語の説明
// =============================================================================
// msnodesqlv8(4.5.0)はエラー文を ODBC から UTF-16 で受け取るが、文字列へ変えるときに各文字の
// 下位 1 バイトだけを残す(src/Utility.cpp の `swcvec2str`)。日本語のエラー文は化けて読めず、
// 上位バイトが捨てられているので JS 側で戻すこともできない。そこで、壊れない SQLSTATE と
// エラー番号から説明を引き、化けた原文は出さない。
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

/** ドライバのエラー文が化けているか。印字できる ASCII 以外を含めば化けているとみなす。 */
export function isGarbledDriverText(text: string): boolean {
  return /[^\x20-\x7e]/.test(text);
}
