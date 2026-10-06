// =============================================================================
// fillJinja.ts — 生 Jinja2 テンプレートを作成タブのキャンバス用の値入り HTML へ変換
// =============================================================================
// 役割:
//   生 Jinja2 テンプレートを、作成タブのキャンバスが表示する値入りの編集形態へ描く。値を差し込んで
//   文書として読める見た目にしつつ、原文を印・チップ・固めた要素の中へ残し、保存時に
//   `jinjaMask.ts` の `toTemplate` が原文どおりのテンプレートへ戻せるようにする。
//
//   描画は原文のブロック木(`jinjaLex.ts` の `parseJinja`)を辿って行う。正規表現の最短一致で
//   ブロックを拾うと、入れ子・elif・複数要素の枝・表の中の位置を取り違え、戻した結果が原文と
//   食い違うため。印を置けない位置は `fillAnalysis.ts` の `analyzeFill` が原文の上で先に決め、
//   ここはその結果に従って描くだけにする。
//     - if / for の範囲は、採用した枝の本文の前後に置く HTML コメントの印(`o` / `c`)で囲む。
//       印は採用しなかった枝の原文を持つので、採用した枝への編集だけがその枝へ書き戻る。
//     - for の 2 回目以降の繰り返しは `x` の印の後ろに並べる表示専用の行で、保存時に捨てる。
//     - テキストの位置の単独のトークンはチップ、表の中の文・Jinja コメントは `t` の印にする。
//     - script / 数式は要素ごと伏せたチップ、印を置けない要素は値入りの見た目のまま固める。
//
//   値の評価は `jinjaExpr.ts` の許可リスト評価器で行う(`nunjucks.compile` =
//   `new Function` を使わない)。アプリオリジンの CSP から `'unsafe-eval'` を落とせる
//   ようにするためで、`toFilled` は Worker からも呼ばれる(Worker は同一オリジンで
//   CSP を継承する)。解釈できない式は**握り潰さず数え**、`toFilledWithDiagnostics`
//   が呼び出し側へ返す — 「例外を catch して黙って空文字」の形を残さない。
import type { SampleData } from '@editor/shared';
import {
  analyzeFill,
  type FillAnalysis,
  type FreezeReason,
  type FrozenRegion,
  MATH_TEX_RE,
  OPAQUE_MATH_RE,
  OPAQUE_SCRIPT_RE,
  type OpaqueRegion,
} from './fillAnalysis';
import { Filler, loopCtx, parseForHeader, renderDisplay, takenBranchIndex } from './fillRender';
import { defaultHtmlParser, type HtmlParser } from './htmlParser';
import {
  DATA_JINJA,
  DATA_JINJA_LOOP_ROW,
  DATA_OPAQUE,
  DATA_OPAQUE_KIND,
  rtComment,
} from './jinjaAttrs';
import type { JinjaCtx } from './jinjaExpr';
import { type JinjaNode, type JinjaToken, parseJinja } from './jinjaLex';
import { b64encode, htmlEscape, normalizeForRoundTrip, toTemplate } from './jinjaMask';
import { getBodyInner } from './templateDoc';

// 生成正規表現の定義は `fillAnalysis.ts` に置く。`jinjaMask.ts` の検査と同じ定数を使い、生成と
// 検査が別々の正規表現に分かれないようにする。
export { MATH_TEX_RE, OPAQUE_MATH_RE, OPAQUE_SCRIPT_RE };

/** `toFilled` 1 回ぶんの診断。問題の式を出現順・重複排除で持つ。 */
export interface FillDiagnostics {
  /** 許可リスト評価器が解釈できなかった式(フィルタ等)。 */
  readonly unsupported: readonly string[];
  /**
   * undefined/null に解決された `{{ expr }}`(サンプルデータにキーが無い等)。評価器は
   * 未定義キーを例外にせず undefined を返すため、`unsupported` には載らない — だが表示は
   * 同じ「黙って空」になるので、別軸で数えて表に出す。存在確認に使う `{% if %}` の条件は
   * undefined が正当な値なので対象外(可視テキストの穴だけを数える)。
   */
  readonly missing: readonly string[];
  /** 固めた要素(タグ名と理由)。本文全体を固めたときは tag='body'。 */
  readonly frozen: readonly { tag: string; reason: FreezeReason }[];
  /** 字句解析・ブロックの対応のエラー。無ければ null。 */
  readonly structureError: string | null;
}

// ── 1. 出力の部品 ──

const RAWTEXT_LABEL: Record<string, string> = { style: 'CSS', textarea: '入力欄', title: '題名' };
const RAW_LABEL_CHARS = 20;

/** 単独のトークンのチップ。出力は評価した値を、文・Jinja コメントは原文を見せる。 */
function tokenChip(tok: JinjaToken, ctx: JinjaCtx, f: Filler): string {
  const kind = tok.kind === 'output' ? 'var' : tok.kind;
  const visible = tok.kind === 'output' ? f.expr(tok.body, ctx) : tok.source;
  return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" ${DATA_JINJA}="${b64encode(tok.source)}">${htmlEscape(visible)}</span>`;
}

/**
 * 原文(base64)を運ぶ、中身を見せないチップ。`kind` は部品の種類と見た目を選び、キャンバスの
 * 描画層が振り分けに使う(`script` → 実行、`math` → MathJax / MathML、`rawtext` → ラベルだけ)。
 */
function opaqueChip(source: string, kind: 'script' | 'math' | 'rawtext', label: string): string {
  return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" ${DATA_OPAQUE}="${b64encode(source)}" ${DATA_OPAQUE_KIND}="${kind}">${label}</span>`;
}

/** 表示 HTML の先頭の開始タグ `<tag` の直後へ属性を差し込む。`tagLen` は原文のタグ名の長さ。 */
function withAttrs(html: string, tagLen: number, attrs: string): string {
  const at = 1 + tagLen;
  return `${html.slice(0, at)} ${attrs}${html.slice(at)}`;
}

const LOOP_ROW_ATTR = `${DATA_JINJA_LOOP_ROW}=""`;

// ── 2. 編集用の描画 ──

interface EmitCtx {
  src: string;
  a: FillAnalysis;
  f: Filler;
  nextId: () => number;
  frozen: readonly FrozenRegion[];
  opaque: readonly OpaqueRegion[];
}

/** for のテンプレートの行で印を付ける要素。開始位置 → タグ名の長さ。 */
type Rows = ReadonlyMap<number, number>;
const NO_ROWS: Rows = new Map();

function mismatch(): never {
  throw new Error('fillJinja: 解析と描画の不整合');
}

/** 範囲の最上位の要素(親が範囲の外)。for のテンプレートの行として印を付ける。 */
function topLevelRows(e: EmitCtx, from: number, to: number, inherited: Rows): Rows {
  const rows = new Map(inherited);
  for (const el of e.a.scan.elements) {
    if (el.start < from || el.start >= to) continue;
    if (el.parent === null || el.parent.start < from) rows.set(el.start, el.tag.length);
  }
  return rows;
}

/** 固めた要素の表示。値入りの見た目のまま、原文を `data-opaque` に運ぶ。 */
function emitFrozen(e: EmitCtx, r: FrozenRegion, ctx: JinjaCtx, rows: Rows): string {
  const source = e.src.slice(r.start, r.end);
  if (r.form === 'chip') return opaqueChip(source, 'rawtext', RAWTEXT_LABEL[r.tag] ?? r.tag);
  if (r.form === 'body') return mismatch();
  const parsed = parseJinja(source);
  if (!parsed.ok) return mismatch();
  let display = renderDisplay(source, parsed.nodes, ctx, e.f);
  const opaque = `${DATA_OPAQUE}="${b64encode(source)}" ${DATA_OPAQUE_KIND}="frozen"`;
  if (r.tag === 'table') {
    // 表の行の間の値は HTML パーサが表の手前へ追い出す。表そのものに印を付けると追い出された
    // 値が印の外に残って保存へ混ざるので、レイアウトを変えない div で包み、追い出し先ごと運ぶ。
    if (rows.has(r.start)) display = withAttrs(display, r.tag.length, LOOP_ROW_ATTR);
    return `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" ${opaque}>${display}</div>`;
  }
  const type = r.form === 'element-svg' ? 'jinja-frozen-svg' : 'jinja-frozen';
  const attrs = [
    `data-gjs-type="${type}"`,
    opaque,
    ...(rows.has(r.start) ? [LOOP_ROW_ATTR] : []),
  ].join(' ');
  return withAttrs(display, r.tag.length, attrs);
}

function emitOpaque(e: EmitCtx, r: OpaqueRegion): string {
  return opaqueChip(e.src.slice(r.start, r.end), r.kind, r.kind === 'script' ? 'JS' : '∑');
}

/** 原文のまま残すブロック・トークン(属性値の中、または本物の HTML コメントの中)。 */
function isVerbatim(e: EmitCtx, start: number): boolean {
  return e.a.attrTokens.has(start) || e.a.scan.contextAt(start).kind === 'htmlComment';
}

/**
 * [from, to) の原文を、ノード列に沿って編集用に描く。固めた領域・伏せる領域はテキストの途中から
 * 始まり、後ろのノードを丸ごと飲み込むことがあるので、ノード単位ではなく位置のカーソルで進める。
 */
function emitRange(
  e: EmitCtx,
  nodes: readonly JinjaNode[],
  from: number,
  to: number,
  ctx: JinjaCtx,
  rows: Rows,
): string {
  let out = '';
  let pos = from;

  /** pos から end までのテキスト。途中で始まる領域と、行の印を付ける開始タグを差し替える。 */
  const emitText = (end: number) => {
    while (pos < end) {
      const fr = e.frozen.find((r) => r.start >= pos && r.start < end);
      const op = e.opaque.find((r) => r.start >= pos && r.start < end);
      let row = -1;
      for (const s of rows.keys()) if (s >= pos && s < end && (row < 0 || s < row)) row = s;
      const next = Math.min(fr?.start ?? end, op?.start ?? end, row < 0 ? end : row);
      out += e.src.slice(pos, next);
      pos = next;
      if (pos >= end) break;
      if (fr && fr.start === pos) {
        out += emitFrozen(e, fr, ctx, rows);
        pos = fr.end;
      } else if (op && op.start === pos) {
        out += emitOpaque(e, op);
        pos = op.end;
      } else {
        const at = pos + 1 + (rows.get(pos) ?? 0);
        out += `${e.src.slice(pos, at)} ${LOOP_ROW_ATTR}`;
        pos = at;
      }
    }
  };

  for (const n of nodes) {
    if (n.type === 'text') {
      if (n.end <= pos) continue;
      if (n.start > pos) mismatch();
      emitText(n.end);
      continue;
    }
    const start = n.type === 'token' ? n.token.start : n.start;
    const end = n.type === 'token' ? n.token.end : n.end;
    if (end <= pos) continue;
    if (start !== pos) mismatch();
    out += emitNode(e, n, ctx, rows);
    pos = end;
  }
  if (pos < to) emitText(to);
  if (pos !== to) mismatch();
  return out;
}

function emitNode(e: EmitCtx, n: Exclude<JinjaNode, { type: 'text' }>, ctx: JinjaCtx, rows: Rows) {
  const { src, f } = e;
  if (n.type === 'token') {
    const tok = n.token;
    if (isVerbatim(e, tok.start)) return tok.source;
    if (e.a.commentOnlyTokens.has(tok.start)) return rtComment({ kind: 't', payload: tok.source });
    return tokenChip(tok, ctx, f);
  }
  if (isVerbatim(e, n.start)) return src.slice(n.start, n.end);
  switch (n.type) {
    case 'raw': {
      const label = htmlEscape(src.slice(n.open.end, n.close.start).slice(0, RAW_LABEL_CHARS));
      return opaqueChip(src.slice(n.start, n.end), 'rawtext', label);
    }
    case 'opaqueBlock':
      return mismatch();
    case 'if': {
      const id = e.nextId();
      const i = takenBranchIndex(n, ctx, f);
      if (i < 0) {
        const open = rtComment({ kind: 'o', id, payload: src.slice(n.start, n.end) });
        return open + rtComment({ kind: 'c', id, payload: '' });
      }
      const br = n.branches[i];
      return (
        rtComment({ kind: 'o', id, payload: src.slice(n.start, br.bodyStart) }) +
        emitRange(e, br.children, br.bodyStart, br.bodyEnd, ctx, rows) +
        rtComment({ kind: 'c', id, payload: src.slice(br.bodyEnd, n.end) })
      );
    }
    case 'for': {
      const id = e.nextId();
      const { body, elseBranch } = n;
      const h = parseForHeader(n.open.body);
      if (!h) f.unsupported.add(n.open.body);
      const items = h ? f.array(h.iter, ctx) : [];
      if (items.length === 0 && elseBranch) {
        return (
          rtComment({ kind: 'o', id, payload: src.slice(n.start, elseBranch.bodyStart) }) +
          emitRange(
            e,
            elseBranch.children,
            elseBranch.bodyStart,
            elseBranch.bodyEnd,
            ctx,
            NO_ROWS,
          ) +
          rtComment({ kind: 'c', id, payload: src.slice(elseBranch.bodyEnd, n.end) })
        );
      }
      const row = topLevelRows(e, body.bodyStart, body.bodyEnd, rows);
      const draw = (c: JinjaCtx, r: Rows) =>
        emitRange(e, body.children, body.bodyStart, body.bodyEnd, c, r);
      let out = rtComment({ kind: 'o', id, payload: src.slice(n.start, body.bodyStart) });
      if (items.length === 0 || !h) {
        // 反復対象が空: 本文を 1 回(ループ変数なし)描き、テンプレートの行として残す。
        out += draw(ctx, row);
      } else {
        out += draw(loopCtx(ctx, h.vars, items, 0), row);
        out += rtComment({ kind: 'x', id });
        for (let i = 1; i < items.length; i++) out += draw(loopCtx(ctx, h.vars, items, i), NO_ROWS);
      }
      return out + rtComment({ kind: 'c', id, payload: src.slice(body.bodyEnd, n.end) });
    }
  }
}

/**
 * 本文全体を固める。文書全体なら `<body>` の中身だけを包み、`<head>` 側は原文のまま残す
 * (編集画面は本文の中身しか使わない)。ブロック木が無いときは Jinja を評価せず原文を見せる。
 */
function emitWholeBody(raw: string, a: FillAnalysis, ctx: JinjaCtx, f: Filler): string {
  const body = a.scan.elements.find((el) => el.tag === 'body');
  let from = 0;
  let to = raw.length;
  if (body) {
    from = body.startTagEnd;
    to = body.end;
    // 終了タグ `</body…>` があれば、その手前まで。
    if (!body.implicitlyClosed) while (to > from && raw[to - 1] !== '<') to--;
    if (!body.implicitlyClosed && to > from) to--;
  }
  const inner = raw.slice(from, to);
  const parsed = a.parse.ok ? parseJinja(inner) : null;
  const display = parsed?.ok ? renderDisplay(inner, parsed.nodes, ctx, f) : inner;
  const wrapped = `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" ${DATA_OPAQUE}="${b64encode(inner)}" ${DATA_OPAQUE_KIND}="body">${display}</div>`;
  return raw.slice(0, from) + wrapped + raw.slice(to);
}

// ── 3. 自己検査 ──

let emitHook: ((html: string) => string) | null = null;

/** テスト専用。出力をわざと壊し、自己検査の落ち方を確かめる。 */
export const __forTest = {
  setEmitHook(fn: ((html: string) => string) | null): void {
    emitHook = fn;
  },
};

/** 出力を `toTemplate` で戻した本文が、原文の本文と往復の正規形で一致するか。 */
function roundTripsToOriginal(raw: string, html: string, parse: HtmlParser): boolean {
  try {
    const back = toTemplate(getBodyInner(html), { asFragment: true }, parse);
    return normalizeForRoundTrip(back, parse) === normalizeForRoundTrip(getBodyInner(raw), parse);
  } catch {
    return false;
  }
}

// ── 4. 公開関数 ──

/**
 * 生 Jinja2(全文または fragment) -> 作成タブのキャンバス用の、`toTemplate` で原文へ戻る HTML。
 * 併せて、許可リストの外で解釈できなかった式と固めた要素を返す。
 *
 * 最後に自分の出力を `toTemplate` で戻して原文と比べ(自己検査)、例外か食い違いがあれば本文全体を
 * 固めた出力へ差し替える。保存時に原文が壊れるより、編集できない領域が増えるほうが安全なため。
 * `parse` は検査用の DOM パーサで、Worker と Node からは linkedom のものが渡される。
 */
export function toFilledWithDiagnostics(
  raw: string,
  sample: SampleData,
  parse: HtmlParser = defaultHtmlParser,
): { html: string; diagnostics: FillDiagnostics } {
  const f = new Filler();
  const a = analyzeFill(raw);
  const ctx = sample as JinjaCtx;
  let html: string;
  let selfCheckFailed = false;
  if (!a.parse.ok || a.frozen.some((r) => r.form === 'body')) {
    html = emitWholeBody(raw, a, ctx, f);
  } else {
    let id = 0;
    const e: EmitCtx = {
      src: raw,
      a,
      f,
      nextId: () => ++id,
      frozen: a.frozen,
      opaque: a.opaque,
    };
    html = emitRange(e, a.parse.nodes, 0, raw.length, ctx, NO_ROWS);
    if (!roundTripsToOriginal(raw, emitHook ? emitHook(html) : html, parse)) {
      html = emitWholeBody(raw, a, ctx, f);
      selfCheckFailed = true;
    }
  }
  const frozen = a.frozen.map((r) => ({ tag: r.tag, reason: r.reason }));
  if (selfCheckFailed) frozen.push({ tag: 'body', reason: 'self-check' });
  return {
    html,
    diagnostics: {
      unsupported: [...f.unsupported],
      missing: [...f.missing],
      frozen,
      structureError: a.parse.ok ? null : a.parse.error.message,
    },
  };
}

/** 既に警告した式(同じ式をループ展開や再読込のたびに何度も出さないため)。 */
const warned = new Set<string>();

/**
 * `toFilledWithDiagnostics` の薄い包み。解釈できない式があってもユーザー向けの挙動は
 * 変えない(空値になるだけで画面は落ちない)が、**無言にはしない** —
 * `catch` で全部を空文字へ落とすと例外もコンソール出力も残らず、CSP で
 * コンパイルが落ちても「値が消えた」以外の手掛かりが無くなる。
 */
export function toFilled(
  raw: string,
  sample: SampleData,
  parse: HtmlParser = defaultHtmlParser,
): string {
  const { html, diagnostics } = toFilledWithDiagnostics(raw, sample, parse);
  const fresh = diagnostics.unsupported.filter((e) => !warned.has(e));
  if (fresh.length > 0) {
    for (const e of fresh) warned.add(e);
    console.warn('[fillJinja] 解釈できない Jinja 式のため値を空にしました:', fresh);
  }
  const freshMissing = diagnostics.missing.filter((e) => !warned.has(e));
  if (freshMissing.length > 0) {
    for (const e of freshMissing) warned.add(e);
    console.warn('[fillJinja] サンプルデータに値が無く空になった式:', freshMissing);
  }
  return html;
}
