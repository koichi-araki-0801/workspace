// =============================================================================
// fillJinja.ts — 生 Jinja2 テンプレートを編集キャンバス用の "filled" HTML へ変換
// =============================================================================
// 役割:
//   生 Jinja2 テンプレートを, エディタキャンバスが表示する "filled"(値入り)編集
//   形態へレンダリングする。Jinja の値を差し込む(編集画面が値の入った文書として
//   読める)一方で, 元の `{{ }}` / `{% %}` ソースを verbatim に保持するため,
//   保存時に `jinjaMask.ts` の `toTemplate` が厳密な Jinja テンプレートを復元できる。
//
//   `jinjaMask.ts` の `toEditable` の「値を持つ」兄弟であり, どちらも GrapesJS へ
//   渡され, どちらも `toTemplate` で無損失に round-trip する。差異:
//     - inline `{{ expr }}` chip は *評価値* を表示する(token テキストではない)。
//     - `{% for %}` ループは sample 要素ごとに 1 行の filled 行へ展開する。先頭行は
//       `{% for %}`/`{% endfor %}` マーカ(data-jinja-open/close)を保持し, 残りは
//       data-jinja-loop-clone を付けて復元時に破棄する。
//     - 単一要素の `{% if %}…{% endif %}` は表示用に taken branch のみを残し,
//       ブロック全体を data-jinja-block に保持する。
//     - `<script>` ブロックは inert なマーカへ mask し(GrapesJS は読み込み時に実
//       script を除去する), 保存時に verbatim 復元する。
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';
import { b64encode, htmlEscape, TOKEN_RE, tokenKind } from './jinjaMask';

type Ctx = Record<string, unknown>;

// 値解決には Nunjucks (Jinja2 互換)を再利用するが autoescape は無効: 解決結果の
// テキストは chip の可視ラベルになり, HTML エスケープは自前で行うため。
const evalEnv = new nunjucks.Environment(undefined, { autoescape: false, throwOnUndefined: false });

function evalExpr(expr: string, ctx: Ctx): string {
  try {
    return evalEnv.renderString(`{{ ${expr} }}`, ctx);
  } catch {
    return '';
  }
}

function evalCond(cond: string, ctx: Ctx): boolean {
  try {
    return evalEnv.renderString(`{% if ${cond} %}1{% else %}0{% endif %}`, ctx).trim() === '1';
  } catch {
    return false;
  }
}

function evalArray(expr: string, ctx: Ctx): unknown[] {
  try {
    const v = JSON.parse(evalEnv.renderString(`{{ (${expr}) | dump }}`, ctx));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 要素の開始 `<tag` 直後に追加属性を挿入する。 */
function insertAttrs(element: string, attrs: string): string {
  return element.replace(/^(<[a-zA-Z][\w-]*)/, `$1 ${attrs}`);
}

/**
 * *テキスト中*(タグ内ではない)の各 Jinja token を locked chip として包む。
 * `jinjaMask.ts` の `wrapInlineTokens` を写したもの。`{{ var }}` chip の可視ラベル
 * だけが `ctx` に対して評価した値で, `{% %}` / `{# #}` token はリテラルソースを
 * ラベルとして保持する。厳密なソース token は常に data-jinja に入るため, ラベルに
 * 関わらず `toTemplate` が復元する。
 */
function fillInline(html: string, ctx: Ctx): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) return part; // タグ — 属性内 Jinja は verbatim に round-trip
      return part.replace(TOKEN_RE, (token) => {
        const kind = tokenKind(token);
        const visible = kind === 'var' ? evalExpr(token.slice(2, -2).trim(), ctx) : token;
        return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-jinja="${b64encode(token)}">${htmlEscape(visible)}</span>`;
      });
    })
    .join('');
}

/**
 * verbatim ソース(base64)を運ぶ locked かつ opaque な chip。`kind` は component の
 * 種別/スタイルを選び, キャンバスの live-render 層が dispatch できるようにする:
 * `script` → 実行, `math` → MathJax (TeX)で組版 または MathML を描画。
 */
function opaqueChip(source: string, kind: 'script' | 'math', label: string): string {
  return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-opaque="${b64encode(source)}" data-opaque-kind="${kind}">${label}</span>`;
}

// MathJax が受理する TeX 区切り: $$…$$ / \(…\) / \[…\]。(単独の `$` はマッチさせ
// ない — レポート本文の通貨表記と衝突するため。)
const MATH_TEX_RE = /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;

/**
 * 構造パスの前に, GrapesJS と相性の悪い / math コンテンツを opaque chip へ mask
 * する。GrapesJS が `<script>` を除去したり MathML を再構成したりできず, テキスト
 * 編集が数式を分断できないようにするため。MathJax (TeX)も MathML も mask する。
 * 順序が重要: 要素(script, 次に `<math>`)を TeX より先に処理し, script/MathML の
 * body が TeX として再走査されないようにする。
 */
function maskOpaque(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, (m) => opaqueChip(m, 'script', 'JS'));
  s = s.replace(/<math\b[\s\S]*?<\/math>/gi, (m) => opaqueChip(m, 'math', '∑'));
  s = s.replace(MATH_TEX_RE, (m) => opaqueChip(m, 'math', '∑'));
  return s;
}

// `{% for v in iter %}<el>…</el>{% endfor %}` — body は nested statement を持たない
// 単一要素(`jinjaMask.ts` の `absorbBlocks` が受理するのと同じ形)。
const FOR_RE = new RegExp(
  '(\\{%\\s*for\\s+(\\w+)\\s+in\\s+([\\s\\S]*?)%\\})' + // 1 open, 2 var, 3 iterable
    '\\s*(<([a-zA-Z][\\w-]*)\\b(?:[^>]*>)(?:(?!\\{%)[\\s\\S])*?<\\/\\5>)\\s*' + // 4 element, 5 tag
    '(\\{%\\s*endfor\\s*%\\})', // 6 close
  'g',
);

function expandLoops(html: string, ctx: Ctx): string {
  return html.replace(
    FOR_RE,
    (_m, open: string, varName: string, iter: string, element: string, _tag, close: string) => {
      const items = evalArray(iter.trim(), ctx);
      const tplRow = insertAttrs(
        element,
        `data-jinja-open="${b64encode(open)}" data-jinja-close="${b64encode(close)}"`,
      );
      // iterable が空: ループが生き残るよう(未 fill の)テンプレート行を残す。
      if (items.length === 0) return fillInline(tplRow, ctx);
      return items
        .map((item, i) => {
          const loopCtx: Ctx = {
            ...ctx,
            [varName]: item,
            loop: {
              index: i + 1,
              index0: i,
              first: i === 0,
              last: i === items.length - 1,
              length: items.length,
            },
          };
          // 先頭行が for/endfor マーカを運ぶ。clone は表示専用。
          const row = i === 0 ? tplRow : insertAttrs(element, 'data-jinja-loop-clone');
          return fillInline(row, loopCtx);
        })
        .join('\n');
    },
  );
}

// `{% if c %}A{% else %}B{% endif %}` (else は任意)。Non-greedy: nesting なしを
// 前提とし, レポートテンプレートの単一要素 branch に合致する。
const IF_RE = /\{%\s*if\s+([\s\S]*?)%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g;

function collapseIfs(html: string, ctx: Ctx): string {
  return html.replace(IF_RE, (whole, cond: string, trueB: string, elseB: string | undefined) => {
    const taken = (evalCond(cond.trim(), ctx) ? trueB : (elseB ?? '')).trim();
    const el = taken.match(/^<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/);
    // marker を運べるのは単一要素 branch のみ。それ以外は生ブロックを残し,
    // `jinjaMask.ts` の inline chip に処理させる(なお round-trip する)。
    if (!el) return whole;
    return fillInline(insertAttrs(taken, `data-jinja-block="${b64encode(whole)}"`), ctx);
  });
}

/** 生 Jinja2(全文または fragment) -> filled で GrapesJS-safe かつ round-trip 可能な HTML。 */
export function toFilled(raw: string, sample: SampleData): string {
  let s = raw;
  s = maskOpaque(s);
  s = expandLoops(s, sample as Ctx);
  s = collapseIfs(s, sample as Ctx);
  s = fillInline(s, sample as Ctx);
  return s;
}
