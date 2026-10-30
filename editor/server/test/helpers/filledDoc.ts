// =============================================================================
// filledDoc.ts — 編集経路の申請・値入り HTML の種を文書の形にする
// =============================================================================
// 編集経路の受付は body の無い断片を受けない(断片の先頭の style などは DOMParser が head へ移し、
// 紙面に出ないまま効くため。`server/src/repositories/reviewRepo.ts` の `frameOptions`)。テストの
// 値入り HTML の本文を `<html><head></head><body>…</body></html>` に入れる。body を持つ文書はそのまま。

/** 本文 `html` を文書に入れる(既に `<body` を持てばそのまま)。 */
export function filledDoc(html: string): string {
  return /<body[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`;
}
