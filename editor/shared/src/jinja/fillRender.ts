// =============================================================================
// fillRender.ts — ブロック木をサンプルデータで評価し、印もチップも無い値入り HTML を描く
// =============================================================================
// 作成タブで固めた要素(往復の印を置けない範囲)と、本文全体を固めたときの表示、編集タブ用の local の
// fixture(`renderPlainFilled`)に使う。nunjucks の
// 結果に近い素の HTML を出す。式の評価は `fillJinja.ts` の往復用の描画と同じ `Filler` を通し、
// 解釈できない式・値の無い式を両方の描画で同じように数える。ファイルを分けるのは、`fillJinja.ts` が
// 往復用の描画と公開関数を抱えて大きくなりすぎないため。

import type { SampleData } from '../index.js';
import {
  assignJinjaSet,
  evaluateJinjaExpr,
  innerJinjaCtx,
  isJinjaSafe,
  JinjaBudget,
  type JinjaCtx,
  stringifyJinjaValue,
} from './jinjaExpr.js';
import type { JinjaToken } from './jinjaLex.js';
import { type JinjaNode, parseJinja } from './jinjaTree.js';
import { isAllowedSafeMarkup, textPositions } from './safeMarkup.js';

// ── 1. 式の評価 ──

/**
 * 1 回の描画で展開する繰り返しの総数の上限。`range` と入れ子の for で掛け算の回数を作れるので、
 * server で描く経路(ペア同期の描き直し)が止まらなくならないよう、描画ごとに数える。
 */
const MAX_LOOP_ITEMS = 100_000;

/**
 * 1 回の描画で出す文字数の上限。`set` で育てた長い文字列をループで何度も出す書き方は、繰り返しの
 * 回数と式の評価の量が上限の内でも出力だけが掛け算で伸びるので、出した量でも止める。超えたら以後の
 * 繰り返しを展開せず、値を空にする(テキストを途中で切らないので、出力のタグの対応は崩れない)。
 */
const MAX_OUTPUT_CHARS = 10_000_000;

/** 上限で描くのをやめたことを unsupported に載せるときの文言。 */
const OUTPUT_LIMIT_NOTE = '描画の量が上限を超えたため、以降を省きました';

/**
 * `safe` の値の仮置きの囲み(私用領域の文字)。エスケープで変わらず、正規表現の特殊文字でもない。
 */
const PH_OPEN = '\u{e000}';
const PH_CLOSE = '\u{e001}';

/** 描画ごとの推測できない印(値に同じ並びを書いて仮置きを偽造させないため)。 */
function newNonce(): string {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto;
  const a = new Uint32Array(2);
  if (c) c.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 2 ** 32);
  return Array.from(a, (x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * 1 回の描画に紐づく評価器。解釈できない式を空値へ落とすのは画面を落とさないためだが、落としたことを
 * 必ず記録する。
 */
export class Filler {
  /** Set を使うのは同じ式がループ展開で何度も現れるため(件数でなく種類を数える)。 */
  readonly unsupported = new Set<string>();
  readonly missing = new Set<string>();
  private loopItems = 0;
  private emitted = 0;
  /**
   * 1 回の描画のすべての式で共有する評価の量(range やフィルタの掛け算を描画の単位で止める)。
   * 呼び出し側が複数の描画で 1 つを共有すれば、その全体の量を止められる。
   */
  private readonly budget: JinjaBudget;
  /** `safe` の値の仮置き(`finalize` で位置を見て生かエスケープかを決める)。 */
  private readonly pending: { expr: string; html: string }[] = [];
  private readonly nonce = newNonce();

  constructor(budget: JinjaBudget = new JinjaBudget()) {
    this.budget = budget;
  }

  private fail(expr: string): void {
    this.unsupported.add(expr);
  }

  /** for の見出しの解析結果(外側の繰り返しのたびに同じ見出しを読み直さない)。 */
  private readonly forHeaders = new Map<string, ReturnType<typeof parseForHeader>>();

  /** `parseForHeader` を見出しの文字列ごとに 1 回だけ行う。 */
  forHeader(body: string): ReturnType<typeof parseForHeader> {
    if (!this.forHeaders.has(body)) this.forHeaders.set(body, parseForHeader(body));
    return this.forHeaders.get(body) ?? null;
  }

  /** 上限に達して描くのをやめたことを unsupported に 1 回だけ載せる(出力・評価の量のどちらでも)。 */
  noteLimit(): void {
    this.fail(OUTPUT_LIMIT_NOTE);
  }

  /** 出力の上限に達したか。達したら繰り返しの展開をやめる。 */
  get exhausted(): boolean {
    return this.emitted > MAX_OUTPUT_CHARS || this.budget.exhausted;
  }

  /** 出した文字数を数える。上限を超えた初回に unsupported へ載せる。 */
  charge(chars: number): void {
    const was = this.exhausted;
    this.emitted += chars;
    if (!was && this.exhausted) this.fail(OUTPUT_LIMIT_NOTE);
  }

  /**
   * 式を評価して文字列にする。文字列化も評価の量と長さの上限を数えるので(並びの倍化で伸ばせる)、
   * 同じ try の中で行い、上限を超えたら他の解釈できない式と同じく空にして数える。
   */
  private output(expr: string, ctx: JinjaCtx): { v: unknown; s: string } {
    try {
      const v = evaluateJinjaExpr(expr, ctx, this.budget);
      if (v === undefined || v === null) this.missing.add(expr);
      return { v, s: stringifyJinjaValue(v, this.budget) };
    } catch {
      this.fail(expr);
      return { v: undefined, s: '' };
    }
  }

  /**
   * `{{ expr }}` を HTML に置くときの文字列。値は `escapeText` でエスケープする。`safe` の付いた値は、
   * 許可した形の断片(`safeMarkup.ts` の `isAllowedSafeMarkup`)なら仮置きの印を返し、描き終えた HTML
   * の上で `finalize` が位置を見て、テキストの位置なら生で、そうでなければエスケープして置く。形に
   * 外れた `safe` の値はここでエスケープし、見た目が変わるときは unsupported に数える。
   */
  html(expr: string, ctx: JinjaCtx, escapeText: (s: string) => string = escapeHtmlFull): string {
    if (this.exhausted) {
      this.noteLimit();
      return '';
    }
    const { v, s } = this.output(expr, ctx);
    let out: string;
    if (!isJinjaSafe(v)) out = escapeText(s);
    else if (isAllowedSafeMarkup(s)) {
      out = `${PH_OPEN}${this.nonce}${this.pending.length}${PH_CLOSE}`;
      this.pending.push({ expr, html: s });
    } else {
      out = escapeText(s);
      if (out !== s) this.fail(expr);
    }
    this.charge(Math.max(out.length, s.length));
    return out;
  }

  /**
   * 描き終えた HTML の `safe` の仮置きを本物の値へ置き換える。テキストの位置(`textPositions`)で、
   * 直前が `<` でない(値の先頭の文字がタグ名として読まれない)ものだけを生で置き、他はエスケープする。
   * 描画の入口(`renderPlainFilled` と web の `toFilledWithDiagnostics`)が出力全体に 1 度だけ掛ける。
   * 掛け忘れても仮置きの印が残るだけで、生の HTML は入らない。
   */
  finalize(html: string): string {
    if (this.pending.length === 0) return html;
    const re = new RegExp(`${PH_OPEN}${this.nonce}(\\d+)${PH_CLOSE}`, 'g');
    const at = [...html.matchAll(re)].map((m) => m.index ?? -1);
    const text = textPositions(html, at);
    return html.replace(re, (whole, idx: string, offset: number) => {
      const p = this.pending[Number(idx)];
      if (!p) return whole;
      if (text.has(offset) && html[offset - 1] !== '<') return p.html;
      const escaped = escapeHtmlFull(p.html);
      if (escaped !== p.html) this.fail(p.expr);
      return escaped;
    });
  }

  /**
   * `{% set … %}` を実行して `ctx` へ代入する。`ctx` は描画の入口で複製した文脈(またはループの
   * 1 回ぶんの文脈)なので、呼び出し側の値データは書き換わらない。
   */
  assign(tok: JinjaToken, ctx: JinjaCtx): void {
    try {
      assignJinjaSet(tok.body.slice('set'.length), ctx, this.budget);
    } catch {
      this.fail(tok.body);
    }
  }

  /** `{% if cond %}` の分岐判定。nunjucks も JS の真偽値化をそのまま使う。 */
  cond(cond: string, ctx: JinjaCtx): boolean {
    try {
      return Boolean(evaluateJinjaExpr(cond, ctx, this.budget));
    } catch {
      this.fail(cond);
      return false;
    }
  }

  /**
   * `{% for v in iter %}` の反復対象。配列でなければ空(ループは展開しない)。繰り返しの総数が上限を
   * 超えたら、以後は式を評価せずに空を返す(上限を超えた式を unsupported に数える)。
   */
  array(expr: string, ctx: JinjaCtx, varCount = 1): unknown[] {
    if (this.exhausted) {
      this.noteLimit();
      return [];
    }
    if (this.loopItems > MAX_LOOP_ITEMS) return [];
    try {
      const v = evaluateJinjaExpr(expr, ctx, this.budget);
      if (!Array.isArray(v)) return [];
      this.loopItems += v.length;
      // 繰り返しのたびに変数と `loop` を持つ層を作る(`loopCtx`)ので、回数 × 変数の数を数える。
      this.budget.charge(v.length * (1 + varCount));
      if (this.loopItems > MAX_LOOP_ITEMS) {
        this.fail(expr);
        return [];
      }
      return v;
    } catch {
      this.fail(expr);
      return [];
    }
  }
}

/** 範囲を持たない `{% set x = … %}`(ブロックの set は木が opaque として扱う)。 */
export function isSetStatement(tok: JinjaToken): boolean {
  return tok.kind === 'stmt' && tok.keyword === 'set';
}

// ── 2. ブロックの規則 ──

const FOR_HEADER_RE = /^for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+([\s\S]+)$/;

/**
 * for の変数の数の上限。本番パーツの書き方(`for a, b in …` の 2 つ)より十分に大きく、繰り返しの
 * たびに束ねる変数の数で仕事を増やす書き方を形で止める。
 */
const MAX_FOR_VARS = 16;

/**
 * `for a, b in xs` の変数名と反復対象の式。読めない形・変数が多すぎる形は null(呼び出し側が
 * unsupported に数える)。同じ見出しを繰り返し読むときは `Filler.forHeader` を通す(1 回だけ解析する)。
 */
export function parseForHeader(body: string): { vars: string[]; iter: string } | null {
  const m = FOR_HEADER_RE.exec(body);
  if (!m) return null;
  const vars = m[1].split(',').map((v) => v.trim());
  if (vars.length > MAX_FOR_VARS) return null;
  return { vars, iter: m[2].trim() };
}

/**
 * ループの i 番目の文脈。変数が複数なら要素(配列)を順に割り当てる(nunjucks のタプル展開)。
 * 回ごとに `ctx` の内側の層(`innerJinjaCtx`)を新しく作り、ループ変数と `loop` だけを置く。ループの
 * 中の `set` はこの層に置かれるので、外へも次の回へも漏れない(Jinja と同じ。持ち越しは namespace の
 * 属性への代入で行う)。層の prototype は null なので、変数名が `__proto__` でもただのキーになる。
 */
export function loopCtx(ctx: JinjaCtx, vars: string[], items: unknown[], i: number): JinjaCtx {
  const item = items[i];
  const layer = innerJinjaCtx(ctx);
  if (vars.length === 1) layer[vars[0]] = item;
  else for (const [k, v] of vars.entries()) layer[v] = Array.isArray(item) ? item[k] : undefined;
  layer.loop = {
    index: i + 1,
    index0: i,
    first: i === 0,
    last: i === items.length - 1,
    length: items.length,
    previtem: i > 0 ? items[i - 1] : undefined,
  };
  return layer;
}

/**
 * 採用する枝の番号。`if` → `elif`/`elseif` の順に条件を評価して最初に真の枝、どれも偽なら `else`、
 * それも無ければ -1。往復用の描画(印の前半・後半の切り方)と表示用の描画で同じ枝を選ぶための共有点。
 */
export function takenBranchIndex(
  node: Extract<JinjaNode, { type: 'if' }>,
  ctx: JinjaCtx,
  f: Filler,
): number {
  for (let i = 0; i < node.branches.length; i++) {
    const { keyword, body } = node.branches[i].tag;
    if (keyword === 'else') return i;
    const cond = body.slice((keyword ?? '').length).trim();
    if (f.cond(cond, ctx)) return i;
  }
  return -1;
}

/** 出力の値のエスケープ。nunjucks の autoescape と同じ 5 文字を置き換える(属性値の中でも安全)。 */
const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtmlFull(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// ── 3. 表示用の描画 ──

/**
 * ブロック木を評価して素の HTML にする。Jinja コメントと範囲を持たない文と `opaqueBlock`(macro 等)は
 * 何も出さず、`raw` は中身を原文のまま出す。属性値の中の出力も同じくエスケープした値に置き換わる
 * (木は HTML の文脈を見ないため)。`set` は `ctx` へ代入するので、呼び出し側は複製した文脈を渡す。
 * if の枝は同じ `ctx` で描くので、枝の中の `set` は if の後ろへ届く(Jinja と同じ)。
 */
export function renderDisplay(
  src: string,
  nodes: readonly JinjaNode[],
  ctx: JinjaCtx,
  f: Filler,
): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += src.slice(n.start, n.end);
        f.charge(n.end - n.start);
        break;
      case 'token':
        if (n.token.kind === 'output') out += f.html(n.token.body, ctx);
        else if (isSetStatement(n.token)) f.assign(n.token, ctx);
        break;
      case 'raw':
        out += src.slice(n.open.end, n.close.start);
        f.charge(n.close.start - n.open.end);
        break;
      case 'opaqueBlock':
        break;
      case 'if': {
        const i = takenBranchIndex(n, ctx, f);
        if (i >= 0) out += renderDisplay(src, n.branches[i].children, ctx, f);
        break;
      }
      case 'for': {
        const header = f.forHeader(n.open.body);
        if (!header) {
          f.unsupported.add(n.open.body);
          out += renderDisplay(src, n.body.children, ctx, f);
          break;
        }
        const items = f.array(header.iter, ctx, header.vars.length);
        for (let i = 0; i < items.length; i++) {
          if (f.exhausted) {
            f.noteLimit();
            break;
          }
          out += renderDisplay(src, n.body.children, loopCtx(ctx, header.vars, items, i), f);
        }
        if (items.length === 0 && n.elseBranch)
          out += renderDisplay(src, n.elseBranch.children, ctx, f);
        break;
      }
    }
  }
  return out;
}

/**
 * 往復用の印を出さずに Jinja を値入りの HTML へ描く。用途は 3 つ。
 *   1. 編集タブ用の値入り HTML(local の fixture)の生成。本番の `filled/` は別ツールが置く値埋め込み
 *      済みのファイルで往復用の印を持たないので、fixture も印を出さない描画器だけで作る(`toFilled` は
 *      作成タブ用)。
 *   2. 作成タブの canvas(本番の経路でも)で、Jinja を含む本文の `<style>` をサンプルで描いて canvas
 *      専用の複製に入れる(`bodyStyle.ts` の `renderJinjaStyleCss`)。複製は保存内容に載らない。
 *   3. 編集タブへ挿入するカタログのパーツを、値ファイルの値で地の HTML にする(web の `partRender.ts`)。
 * 壊れたテンプレートは黙って通さず例外で止める。2 の呼び出し側はそれを受けて複製を作らず、3 の
 * 呼び出し側は挿入を止める。
 * `opts.budget` を渡すと評価の量をその budget から引く。server が 1 回の承認で何度も描くとき、
 * 描画ごとの上限の掛け算にならないよう全体で 1 つを共有するために使う。
 */
export function renderPlainFilled(
  raw: string,
  sample: SampleData,
  opts: { budget?: JinjaBudget } = {},
): { html: string; diagnostics: { unsupported: readonly string[]; missing: readonly string[] } } {
  const r = parseJinja(raw);
  if (!r.ok) throw new Error(`renderPlainFilled: ${r.error.message} (位置 ${r.error.at})`);
  const f = new Filler(opts.budget);
  const html = f.finalize(renderDisplay(raw, r.nodes, { ...sample } as JinjaCtx, f));
  return { html, diagnostics: { unsupported: [...f.unsupported], missing: [...f.missing] } };
}
