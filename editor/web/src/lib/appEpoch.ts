// =============================================================================
// appEpoch.ts — サーバ/dev 起動ごとの epoch を読む(再起動検知)
// =============================================================================
// 配信側(dev は Vite の `transformIndexHtml`、本番は Express)が index.html の
// `<meta name="x-app-epoch">` に起動 epoch を注入する。ログイン時に保存した epoch と
// 突き合わせ、不一致(= サーバ/dev 再起動)なら local セッションを無効化して再ログインを
// 強制する(local モードには再起動耐性のあるサーバセッションが無いための代替)。

/** 配信 HTML に注入された起動 epoch。meta 未注入時は空文字を返す。 */
export function currentAppEpoch(): string {
  const meta = document.querySelector('meta[name="x-app-epoch"]');
  return meta?.getAttribute('content') ?? '';
}

/**
 * 「サーバ/dev 再起動でセッションが切れた」かを判定する純粋関数(表示メッセージ用)。
 * 直前ログイン時の epoch(`prev`)が在り、未認証(`authed=false`)で、かつ現 epoch(`current`)
 * と食い違うときだけ真。手動ログアウト(prev を消す)・初回訪問(prev=null)・通常の TTL 失効
 * (epoch 一致)では偽になる。`stores/auth.ts` の `bootstrap` から使う。
 */
export function restartEnded(prev: string | null, current: string, authed: boolean): boolean {
  return !authed && prev !== null && prev !== current;
}
