// =============================================================================
// jinjaLex.ts — Jinja2 テンプレートの字句解析
// =============================================================================
// 作成タブの往復(`fillJinja.ts` の `toFilled` ⇄ `jinjaMask.ts` の `toTemplate`)が、原文の
// 位置で判断するための土台。正規表現の最短一致では入れ子・elif・空白制御を数えられないため、
// 区切りを 1 文字ずつ読み、原文上の位置つきでトークンに切り出す。nunjucks の parser は使わない
// (式の構文木は要らず、要るのは原文上の位置と開閉の対応だけ。parser はコンパイラの一部で、
// アプリオリジンでのコンパイル経路を増やしたくない)。

// ── 1. 字句解析 ──
// 字句解析は申請の関所(印の検出)と共有するため shared に置く。ここでは再輸出だけする。

import { type JinjaToken, lexJinja } from '@editor/shared';

export { type JinjaToken, type JinjaTokenKind, type LexResult, lexJinja } from '@editor/shared';

// ── 2. ブロック木 ──
// 開閉の対応はスタックで取る。対応が取れない入力は推測で補わずエラーにする(往復の可否は
// 呼び出し側がこの結果で決める)。位置はすべて原文上のもの。

export interface JinjaBranch {
  tag: JinjaToken;
  bodyStart: number;
  bodyEnd: number;
  children: JinjaNode[];
}
export type JinjaNode =
  | { type: 'text'; start: number; end: number }
  | { type: 'token'; token: JinjaToken }
  | { type: 'raw'; open: JinjaToken; close: JinjaToken; start: number; end: number }
  | { type: 'if'; branches: JinjaBranch[]; close: JinjaToken; start: number; end: number }
  | {
      type: 'for';
      open: JinjaToken;
      body: JinjaBranch;
      elseBranch: JinjaBranch | null;
      close: JinjaToken;
      start: number;
      end: number;
    }
  | { type: 'opaqueBlock'; open: JinjaToken; close: JinjaToken; start: number; end: number };
export type ParseResult =
  | { ok: true; nodes: JinjaNode[]; tokens: JinjaToken[] }
  | { ok: false; error: { message: string; at: number } };

const BLOCK_TAG_KEYWORDS = new Set([
  'if',
  'elif',
  'elseif',
  'else',
  'endif',
  'for',
  'endfor',
  'raw',
  'endraw',
  'verbatim',
  'endverbatim',
  'macro',
  'endmacro',
  'call',
  'endcall',
  'filter',
  'endfilter',
  'block',
  'endblock',
  'with',
  'endwith',
  'autoescape',
  'endautoescape',
  'endset',
]);
export function isBlockTagKeyword(k: string | null): boolean {
  return k !== null && BLOCK_TAG_KEYWORDS.has(k);
}

const OPAQUE_KEYWORDS = new Set(['macro', 'call', 'filter', 'block', 'with', 'autoescape']);

/** 中身を木にしないブロックの開きか。`set` は代入を持たない形(ブロック形)だけ。 */
function opensOpaque(tok: JinjaToken): boolean {
  if (tok.keyword === null) return false;
  if (OPAQUE_KEYWORDS.has(tok.keyword)) return true;
  return tok.keyword === 'set' && !tok.body.includes('=');
}

/** 閉じを持ち、中身を木にするかそのまま運ぶブロックの開き。 */
const OPEN_BLOCK_KEYWORDS = new Set(['if', 'for', 'raw', 'verbatim']);

/**
 * 閉じを持つブロックの開き(`if` `for` `raw` `verbatim` と、中身を木にしないブロックの開き)の数。
 * 字句として読めなければ null。作成経路の申請の確認で、元のテンプレートより減っていないかを見る
 * (範囲の印の開きと閉じを両方消すと、例外にならずにブロックが地の本文として保存されるため)。
 * `raw` の中身は字句解析が読み飛ばすので数えない。
 */
export function countJinjaBlockOpens(src: string): number | null {
  const lexed = lexJinja(src);
  if (!lexed.ok) return null;
  return lexed.tokens.filter(
    (t) => t.kind === 'stmt' && (OPEN_BLOCK_KEYWORDS.has(t.keyword ?? '') || opensOpaque(t)),
  ).length;
}

interface Frame {
  kind: 'root' | 'if' | 'for' | 'opaque';
  open: JinjaToken | null;
  branches: JinjaBranch[];
  seenElse: boolean;
  /** opaque のみ: 同種の入れ子の深さ。 */
  depth: number;
}

function newBranch(tag: JinjaToken): JinjaBranch {
  return { tag, bodyStart: tag.end, bodyEnd: tag.end, children: [] };
}

export function parseJinja(src: string): ParseResult {
  const lexed = lexJinja(src);
  if (!lexed.ok) return lexed;
  const { tokens } = lexed;
  const fail = (message: string, at: number): ParseResult => ({
    ok: false,
    error: { message, at },
  });

  const rootTag = { start: 0, end: 0 } as JinjaToken;
  const stack: Frame[] = [
    { kind: 'root', open: null, branches: [newBranch(rootTag)], seenElse: false, depth: 0 },
  ];
  const top = () => stack[stack.length - 1];
  const cur = (f: Frame) => f.branches[f.branches.length - 1];
  const push = (n: JinjaNode) => cur(top()).children.push(n);

  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const f = top();
    if (f.kind !== 'opaque' && tok.start > pos) push({ type: 'text', start: pos, end: tok.start });
    pos = tok.end;
    const kw = tok.kind === 'stmt' ? tok.keyword : null;

    if (f.kind === 'opaque') {
      const name = f.open?.keyword;
      if (kw && opensOpaque(tok) && kw === name) f.depth++;
      else if (kw === `end${name}` && --f.depth === 0) {
        stack.pop();
        push({
          type: 'opaqueBlock',
          open: f.open as JinjaToken,
          close: tok,
          start: (f.open as JinjaToken).start,
          end: tok.end,
        });
      }
      continue;
    }

    if (kw === null) {
      push({ type: 'token', token: tok });
      continue;
    }
    if (kw === 'if' || kw === 'for') {
      stack.push({ kind: kw, open: tok, branches: [newBranch(tok)], seenElse: false, depth: 0 });
    } else if (kw === 'elif' || kw === 'elseif') {
      if (f.kind !== 'if') return fail(`対応する if が無い ${kw}`, tok.start);
      if (f.seenElse) return fail(`else の後の ${kw}`, tok.start);
      cur(f).bodyEnd = tok.start;
      f.branches.push(newBranch(tok));
    } else if (kw === 'else') {
      if (f.kind !== 'if' && f.kind !== 'for')
        return fail('対応する if / for が無い else', tok.start);
      if (f.seenElse) return fail('2 個目の else', tok.start);
      f.seenElse = true;
      cur(f).bodyEnd = tok.start;
      f.branches.push(newBranch(tok));
    } else if (kw === 'endif' || kw === 'endfor') {
      if (f.kind !== kw.slice(3)) return fail(`対応しない ${kw}`, tok.start);
      cur(f).bodyEnd = tok.start;
      stack.pop();
      const open = f.open as JinjaToken;
      if (f.kind === 'if') {
        push({ type: 'if', branches: f.branches, close: tok, start: open.start, end: tok.end });
      } else {
        push({
          type: 'for',
          open,
          body: f.branches[0],
          elseBranch: f.branches[1] ?? null,
          close: tok,
          start: open.start,
          end: tok.end,
        });
      }
    } else if (kw === 'raw' || kw === 'verbatim') {
      const close = tokens[i + 1];
      if (!close || close.keyword !== `end${kw}`) return fail(`閉じていない ${kw}`, tok.start);
      push({ type: 'raw', open: tok, close, start: tok.start, end: close.end });
      pos = close.end;
      i++;
    } else if (opensOpaque(tok)) {
      stack.push({
        kind: 'opaque',
        open: tok,
        branches: [newBranch(tok)],
        seenElse: false,
        depth: 1,
      });
    } else if (kw.startsWith('end') && isBlockTagKeyword(kw)) {
      return fail(`対応しない ${kw}`, tok.start);
    } else {
      push({ type: 'token', token: tok });
    }
  }

  const last = top();
  if (last.kind !== 'root') {
    const open = last.open as JinjaToken;
    return fail(`閉じていない ${open.keyword}`, open.start);
  }
  if (pos < src.length) push({ type: 'text', start: pos, end: src.length });
  return { ok: true, nodes: last.branches[0].children, tokens };
}
