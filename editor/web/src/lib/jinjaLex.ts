// =============================================================================
// jinjaLex.ts — Jinja2 テンプレートの字句解析
// =============================================================================
// 作成タブの往復(`fillJinja.ts` の `toFilled` ⇄ `jinjaMask.ts` の `toTemplate`)が、原文の
// 位置で判断するための土台。正規表現の最短一致では入れ子・elif・空白制御を数えられないため、
// 区切りを 1 文字ずつ読み、原文上の位置つきでトークンに切り出す。nunjucks の parser は使わない
// (式の構文木は要らず、要るのは原文上の位置と開閉の対応だけ。parser はコンパイラの一部で、
// アプリオリジンでのコンパイル経路を増やしたくない)。

export type JinjaTokenKind = 'output' | 'stmt' | 'comment';
export interface JinjaToken {
  kind: JinjaTokenKind;
  start: number;
  end: number;
  source: string;
  trimLeft: boolean;
  trimRight: boolean;
  keyword: string | null;
  body: string;
}
export type LexResult =
  | { ok: true; tokens: JinjaToken[] }
  | { ok: false; error: { message: string; at: number } };

const OPEN: Record<string, { kind: JinjaTokenKind; close: string }> = {
  '{{': { kind: 'output', close: '}}' },
  '{%': { kind: 'stmt', close: '%}' },
  '{#': { kind: 'comment', close: '#}' },
};
const RAW_END: Record<string, RegExp> = {
  raw: /\{%[-+]?\s*endraw\s*[-+]?%\}/g,
  verbatim: /\{%[-+]?\s*endverbatim\s*[-+]?%\}/g,
};

/** 閉じ記号の位置(閉じ記号の先頭)。`quoted` なら引用符の中を読み飛ばす。 */
function findClose(src: string, from: number, close: string, quoted: boolean): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (quoted && (c === '"' || c === "'")) {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (src.startsWith(close, i)) return i;
    i++;
  }
  return -1;
}

function makeToken(src: string, start: number, end: number, kind: JinjaTokenKind): JinjaToken {
  const source = src.slice(start, end);
  let inner = source.slice(2, -2);
  const trimLeft = inner.startsWith('-');
  const trimRight = inner.endsWith('-');
  if (inner.startsWith('-') || inner.startsWith('+')) inner = inner.slice(1);
  if (inner.endsWith('-') || inner.endsWith('+')) inner = inner.slice(0, -1);
  const body = inner.trim();
  const keyword = kind === 'stmt' ? (/^[A-Za-z_]\w*/.exec(body)?.[0] ?? null) : null;
  return { kind, start, end, source, trimLeft, trimRight, keyword, body };
}

export function lexJinja(src: string): LexResult {
  const tokens: JinjaToken[] = [];
  let i = 0;
  while (i < src.length) {
    const j = src.indexOf('{', i);
    if (j < 0) break;
    const spec = OPEN[src.slice(j, j + 2)];
    if (!spec) {
      i = j + 1;
      continue;
    }
    const c = findClose(src, j + 2, spec.close, spec.kind !== 'comment');
    if (c < 0)
      return { ok: false, error: { message: `閉じていない ${src.slice(j, j + 2)}`, at: j } };
    const tok = makeToken(src, j, c + 2, spec.kind);
    tokens.push(tok);
    i = tok.end;
    const rawEnd = tok.keyword ? RAW_END[tok.keyword] : undefined;
    if (rawEnd) {
      rawEnd.lastIndex = i;
      const m = rawEnd.exec(src);
      if (!m)
        return { ok: false, error: { message: `閉じていない ${tok.keyword}`, at: tok.start } };
      tokens.push(makeToken(src, m.index, m.index + m[0].length, 'stmt'));
      i = m.index + m[0].length;
    }
  }
  return { ok: true, tokens };
}
