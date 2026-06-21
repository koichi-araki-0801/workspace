// =============================================================================
// templateDoc.ts — GrapesJS で `<body>` 内 HTML だけを編集するヘルパ
// =============================================================================
// 役割:
//   GrapesJS では `<body>` の inner HTML だけを編集し, doctype/`<head>`(これ自体が
//   `<title>` や `<link href>` 等に Jinja を含みうる)は verbatim に保持する。

const BODY_RE = /^([\s\S]*?<body[^>]*>)([\s\S]*?)(<\/body>[\s\S]*)$/i;

export function getBodyInner(rawHtml: string): string {
  const m = rawHtml.match(BODY_RE);
  return m ? m[2] : rawHtml;
}

export function replaceBodyInner(rawHtml: string, newInner: string): string {
  const m = rawHtml.match(BODY_RE);
  if (!m) return newInner;
  return `${m[1]}${newInner}${m[3]}`;
}
