// =============================================================================
// fillRender.ts — ブロック木をサンプルデータで評価し、印もチップも無い値入り HTML を描く
// =============================================================================
// 作成タブで固めた要素(往復の印を置けない範囲)と、本文全体を固めたときの表示、編集タブ用の local の
// fixture(`renderPlainFilled`)に使う。nunjucks の
// 結果に近い素の HTML を出す。式の評価は `fillJinja.ts` の往復用の描画と同じ `Filler` を通し、
// 解釈できない式・値の無い式を両方の描画で同じように数える。ファイルを分けるのは、`fillJinja.ts` が
// 往復用の描画と公開関数を抱えて大きくなりすぎないため。

import type { SampleData } from '@editor/shared';
import { evaluateJinjaExpr, type JinjaCtx, stringifyJinjaValue } from './jinjaExpr';
import { type JinjaNode, parseJinja } from './jinjaLex';

// ── 1. 式の評価 ──

/**
 * 1 回の描画に紐づく評価器。解釈できない式を空値へ落とすのは画面を落とさないためだが、落としたことを
 * 必ず記録する。
 */
export class Filler {
  /** Set を使うのは同じ式がループ展開で何度も現れるため(件数でなく種類を数える)。 */
  readonly unsupported = new Set<string>();
  readonly missing = new Set<string>();

  private fail(expr: string): void {
    this.unsupported.add(expr);
  }

  /** `{{ expr }}` の可視テキスト。 */
  expr(expr: string, ctx: JinjaCtx): string {
    try {
      const v = evaluateJinjaExpr(expr, ctx);
      if (v === undefined || v === null) this.missing.add(expr);
      return stringifyJinjaValue(v);
    } catch {
      this.fail(expr);
      return '';
    }
  }

  /** `{% if cond %}` の分岐判定。nunjucks も JS の真偽値化をそのまま使う。 */
  cond(cond: string, ctx: JinjaCtx): boolean {
    try {
      return Boolean(evaluateJinjaExpr(cond, ctx));
    } catch {
      this.fail(cond);
      return false;
    }
  }

  /** `{% for v in iter %}` の反復対象。配列でなければ空(ループは展開しない)。 */
  array(expr: string, ctx: JinjaCtx): unknown[] {
    try {
      const v = evaluateJinjaExpr(expr, ctx);
      return Array.isArray(v) ? v : [];
    } catch {
      this.fail(expr);
      return [];
    }
  }
}

// ── 2. ブロックの規則 ──

const FOR_HEADER_RE = /^for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+([\s\S]+)$/;

/** `for a, b in xs` の変数名と反復対象の式。読めない形は null(呼び出し側が unsupported に数える)。 */
export function parseForHeader(body: string): { vars: string[]; iter: string } | null {
  const m = FOR_HEADER_RE.exec(body);
  if (!m) return null;
  return { vars: m[1].split(',').map((v) => v.trim()), iter: m[2].trim() };
}

/** ループの i 番目の文脈。変数が複数なら要素(配列)を順に割り当てる(nunjucks のタプル展開)。 */
export function loopCtx(ctx: JinjaCtx, vars: string[], items: unknown[], i: number): JinjaCtx {
  const item = items[i];
  const bound: JinjaCtx = {};
  if (vars.length === 1) bound[vars[0]] = item;
  else for (const [k, v] of vars.entries()) bound[v] = Array.isArray(item) ? item[k] : undefined;
  return {
    ...ctx,
    ...bound,
    loop: {
      index: i + 1,
      index0: i,
      first: i === 0,
      last: i === items.length - 1,
      length: items.length,
    },
  };
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
 * ブロック木を評価して素の HTML にする。Jinja コメントと範囲を持たない文(`set` など)と
 * `opaqueBlock`(macro 等)は何も出さず、`raw` は中身を原文のまま出す。属性値の中の出力も同じく
 * エスケープした値に置き換わる(木は HTML の文脈を見ないため)。
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
        break;
      case 'token':
        if (n.token.kind === 'output') out += escapeHtmlFull(f.expr(n.token.body, ctx));
        break;
      case 'raw':
        out += src.slice(n.open.end, n.close.start);
        break;
      case 'opaqueBlock':
        break;
      case 'if': {
        const i = takenBranchIndex(n, ctx, f);
        if (i >= 0) out += renderDisplay(src, n.branches[i].children, ctx, f);
        break;
      }
      case 'for': {
        const header = parseForHeader(n.open.body);
        if (!header) {
          f.unsupported.add(n.open.body);
          out += renderDisplay(src, n.body.children, ctx, f);
          break;
        }
        const items = f.array(header.iter, ctx);
        for (let i = 0; i < items.length; i++)
          out += renderDisplay(src, n.body.children, loopCtx(ctx, header.vars, items, i), f);
        if (items.length === 0 && n.elseBranch)
          out += renderDisplay(src, n.elseBranch.children, ctx, f);
        break;
      }
    }
  }
  return out;
}

/**
 * 往復用の印を出さずに Jinja を値入りの HTML へ描く。用途は 2 つ。
 *   1. 編集タブ用の値入り HTML(local の fixture)の生成。本番の `filled/` は別ツールが置く値埋め込み
 *      済みのファイルで往復用の印を持たないので、fixture も印を出さない描画器だけで作る(`toFilled` は
 *      作成タブ用)。
 *   2. 作成タブの canvas(本番の経路でも)で、Jinja を含む本文の `<style>` をサンプルで描いて canvas
 *      専用の複製に入れる(`bodyStyle.ts` の `renderJinjaStyleCss`)。複製は保存内容に載らない。
 * 壊れたテンプレートは黙って通さず例外で止める。2 の呼び出し側はそれを受けて複製を作らない。
 */
export function renderPlainFilled(
  raw: string,
  sample: SampleData,
): { html: string; diagnostics: { unsupported: readonly string[]; missing: readonly string[] } } {
  const r = parseJinja(raw);
  if (!r.ok) throw new Error(`renderPlainFilled: ${r.error.message} (位置 ${r.error.at})`);
  const f = new Filler();
  const html = renderDisplay(raw, r.nodes, sample as JinjaCtx, f);
  return { html, diagnostics: { unsupported: [...f.unsupported], missing: [...f.missing] } };
}
