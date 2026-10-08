// =============================================================================
// jinjaLex.ts — Jinja2 テンプレートの字句解析(原文上の位置つきのトークン列)
// =============================================================================
// 作成タブの往復(web の `fillJinja.ts` / `jinjaMask.ts`)と、申請の関所の印の検出
// (`security/editingMarkers.ts`)が同じ区切りで Jinja を読むよう、ここに 1 つだけ置く。区切りが
// 分かれると、関所が伏せる範囲とエディタが伏せる範囲がずれ、その差で印を見落とす。
// 正規表現の最短一致では引用符の中の閉じ記号や `{% raw %}` を扱えないため、1 文字ずつ読む。

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

/**
 * Jinja の区切り記号の正典。関所の印の検出(`security/editingMarkers.ts`)、不変性の照合
 * (`server/src/security/templateScripts.ts`)、web の最短一致の正規表現(`web/src/lib/jinjaAttrs.ts`
 * の `JINJA_TOKEN_RE`)がここから組む。片側だけ区切りを足すと、伏せる範囲がずれて印を見落とす。
 */
export const JINJA_DELIMS = [
  { open: '{{', close: '}}', kind: 'output' },
  { open: '{%', close: '%}', kind: 'stmt' },
  { open: '{#', close: '#}', kind: 'comment' },
] as const satisfies ReadonlyArray<{ open: string; close: string; kind: JinjaTokenKind }>;

const OPEN: ReadonlyMap<string, { kind: JinjaTokenKind; close: string }> = new Map(
  JINJA_DELIMS.map((d) => [d.open, { kind: d.kind, close: d.close }]),
);

/** 開き記号(`{{` `{%` `{#` のどれか 2 文字)に対の閉じ記号。開き記号でなければ undefined。 */
export function jinjaCloserOf(open: string): string | undefined {
  return OPEN.get(open)?.close;
}
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
    const spec = OPEN.get(src.slice(j, j + 2));
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
