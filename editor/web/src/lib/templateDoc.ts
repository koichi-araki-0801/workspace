/**
 * Helpers to edit only the <body> inner HTML in GrapesJS while preserving the
 * doctype/<head> (which may itself contain Jinja in <title>, <link href>, etc.)
 * verbatim.
 */

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
