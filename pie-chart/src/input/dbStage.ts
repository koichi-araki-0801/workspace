// =============================================================================
// input/dbStage.ts — DB 取得の失敗を「どの段階で止まったか」付きで表すエラー型
// =============================================================================
// exe はドライバを一時フォルダへ書き出して読み込むため、配布先で止まる場所が複数ある
// (書き出し・照合・読み込み・接続・実行・子プロセス)。メッセージだけでは、アプリ制御
// (AppLocker / WDAC / EDR) に止められたのか、DB 側の問題なのかを利用者が切り分けられない。
// 段階を型で持たせ、CLI が `[db:<stage>]` として表示する。
// =============================================================================

export type DbStage = 'extract' | 'verify' | 'load' | 'connect' | 'query' | 'child';

export class DbStageError extends Error {
  readonly stage: DbStage;

  constructor(stage: DbStage, message: string) {
    super(message);
    this.name = 'DbStageError';
    this.stage = stage;
  }
}

/** Ctrl+C などで DB 取得を中断した。CLI は後片付けの後に終了コード 130 で終わる。 */
export class InterruptedError extends Error {
  constructor() {
    super('Interrupted.');
    this.name = 'InterruptedError';
  }
}

/** catch した値をメッセージ文字列にする(Error 以外が投げられても落とさない)。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
