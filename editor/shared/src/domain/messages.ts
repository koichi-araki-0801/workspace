// messages.ts — server と web(ローカル実装)で同じ文言・同じ判定を使いたい利用者向けメッセージ。
// 片方だけ直して文言が割れるのを避けるため、ここに 1 本だけ置く。

/**
 * CSS/HTML が外部参照を含むため PDF を作らなかったときの文言。
 * 機械可読コード `DOCUMENT_EXTERNAL_REF` と対で返す。外部クライアントの契約なので
 * 変えるときは OpenAPI も見直す。
 */
export const EXTERNAL_REF_MESSAGE =
  'CSSまたはHTMLに外部参照（@import / 絶対URLのurl() / 絶対URLのhref・src）が含まれるため' +
  'PDFを作成できません。' +
  'フォントや画像やスクリプトはテンプレートに同梱し、文書からの相対パス' +
  '（../css/… ../js/… ../images/…。CSS の中では fonts/… ../images/…）で指定してください。';

/** 外部参照を報告するとき、応答・表示へ載せる件数の上限。全部返すと入力の反射になる。 */
export const MAX_REPORTED_REFS = 5;

/** 件数が上限に達しているか(追加の可否にだけ使う)。 */
export function countAtCapacity(count: number, max: number): boolean {
  return count >= max;
}

/** 1 テンプレートのメモ数(パーツキー数)が上限に達したときの文言。 */
export function notesCapacityMessage(max: number): string {
  return `このテンプレートのメモは上限(${max} 件)に達しています`;
}

/** 1 パーツの投稿数が上限に達したときの文言。 */
export function entriesCapacityMessage(max: number): string {
  return `このパーツのメモは上限(${max} 件)に達しています。不要なメモを削除してください。`;
}
