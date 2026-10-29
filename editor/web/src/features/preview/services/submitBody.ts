// =============================================================================
// submitBody.ts — 値入り HTML の申請の本文の組み立て(純関数)
// =============================================================================
// 申請(`templatePreviewService.ts` の値入り HTML の分岐)と、編集画面の変更の番号
// (`features/editor/useChangeNumbers.ts`)が同じ本文を比べるため、組み立てをここ 1 本に置く。
// 片側だけ変えると、編集画面の番号と承認タブの番号がずれる。Jinja 復元の分岐(`toTemplate`)は
// 作成経路の申請だけが通り、編集画面の番号は出さないので対象にしない。

import { getBodyInner, replaceBodyInner } from '@/lib/templateDoc';

/**
 * 値入り HTML(`tpl.filled`)の `<body>` の中身を、canvas の本文(`getBodyHtml()` / 下書きの
 * `html`)の中身へ差し替えた文書。申請の本文そのもの。
 */
export function submitBodyOf(filledHtml: string, canvasBodyHtml: string): string {
  return replaceBodyInner(filledHtml, getBodyInner(canvasBodyHtml));
}
