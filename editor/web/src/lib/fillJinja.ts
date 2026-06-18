/**
 * fillJinja — render a raw Jinja2 template into the "filled" editable form the
 * editor canvas shows: Jinja values are substituted (so the editor reads as a
 * populated document) while the original `{{ }}` / `{% %}` source is preserved
 * verbatim, so {@link toTemplate} restores the exact Jinja template on save.
 *
 * It is the value-bearing sibling of {@link toEditable}; both feed GrapesJS and
 * both round-trip losslessly through {@link toTemplate}. Differences:
 *   - inline `{{ expr }}` chips show the *evaluated value* (not the token text);
 *   - `{% for %}` loops are expanded to one filled row per sample item — the
 *     first row keeps the `{% for %}`/`{% endfor %}` markers (data-jinja-open/
 *     close), the rest are tagged data-jinja-loop-clone and dropped on restore;
 *   - single-element `{% if %}…{% endif %}` keeps only the taken branch for
 *     display, with the whole block preserved in data-jinja-block;
 *   - `<script>` blocks are masked to inert markers (GrapesJS strips real
 *     scripts on load) and restored verbatim on save.
 */
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';
import { b64encode, htmlEscape, TOKEN_RE, tokenKind } from './jinjaMask';

type Ctx = Record<string, unknown>;

// Value resolution reuses Nunjucks (Jinja2-compatible) but without autoescape:
// the resolved text becomes a chip's visible label and is HTML-escaped by us.
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

/** Insert extra attributes right after the element's opening `<tag`. */
function insertAttrs(element: string, attrs: string): string {
  return element.replace(/^(<[a-zA-Z][\w-]*)/, `$1 ${attrs}`);
}

/**
 * Wrap every Jinja token sitting in *text* (not inside a tag) as a locked chip,
 * mirroring jinjaMask's wrapInlineTokens. Only a `{{ var }}` chip's visible label
 * is the value evaluated against `ctx`; `{% %}` / `{# #}` tokens keep their literal
 * source as the label. The exact source token always lives in data-jinja, so
 * toTemplate restores it regardless of the label.
 */
function fillInline(html: string, ctx: Ctx): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) return part; // a tag — attribute Jinja round-trips verbatim
      return part.replace(TOKEN_RE, (token) => {
        const kind = tokenKind(token);
        const visible = kind === 'var' ? evalExpr(token.slice(2, -2).trim(), ctx) : token;
        return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-jinja="${b64encode(token)}">${htmlEscape(visible)}</span>`;
      });
    })
    .join('');
}

/**
 * A locked, opaque chip carrying verbatim source (base64). `kind` selects the
 * component type/styling and lets the canvas live-render layer dispatch:
 * `script` → execute, `math` → typeset with MathJax (TeX) or render MathML.
 */
function opaqueChip(source: string, kind: 'script' | 'math', label: string): string {
  return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-opaque="${b64encode(source)}" data-opaque-kind="${kind}">${label}</span>`;
}

// TeX delimiters MathJax accepts: $$…$$ / \(…\) / \[…\]. (Single `$` is not
// matched — it collides with currency in the report text.)
const MATH_TEX_RE = /\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;

/**
 * Mask GrapesJS-hostile / math content into opaque chips before the structural
 * passes, so GrapesJS cannot strip a `<script>` or restructure MathML, and so
 * a text edit cannot split a formula. Both MathJax (TeX) and MathML are masked.
 * Order matters: elements (script, then `<math>`) before TeX so a script/MathML
 * body is never re-scanned as TeX.
 */
function maskOpaque(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, (m) => opaqueChip(m, 'script', 'JS'));
  s = s.replace(/<math\b[\s\S]*?<\/math>/gi, (m) => opaqueChip(m, 'math', '∑'));
  s = s.replace(MATH_TEX_RE, (m) => opaqueChip(m, 'math', '∑'));
  return s;
}

// `{% for v in iter %}<el>…</el>{% endfor %}` — body is a single element with no
// nested statement (same shape jinjaMask.absorbBlocks accepts).
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
      // Empty iterable: keep the (unfilled) template row so the loop survives.
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
          // First row carries the for/endfor markers; clones are display-only.
          const row = i === 0 ? tplRow : insertAttrs(element, 'data-jinja-loop-clone');
          return fillInline(row, loopCtx);
        })
        .join('\n');
    },
  );
}

// `{% if c %}A{% else %}B{% endif %}` (else optional). Non-greedy: assumes no
// nesting, which matches the report templates' single-element branches.
const IF_RE = /\{%\s*if\s+([\s\S]*?)%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g;

function collapseIfs(html: string, ctx: Ctx): string {
  return html.replace(IF_RE, (whole, cond: string, trueB: string, elseB: string | undefined) => {
    const taken = (evalCond(cond.trim(), ctx) ? trueB : (elseB ?? '')).trim();
    const el = taken.match(/^<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/);
    // Only single-element branches can carry the marker; otherwise leave the raw
    // block for jinjaMask's inline chips to handle (still round-trips).
    if (!el) return whole;
    return fillInline(insertAttrs(taken, `data-jinja-block="${b64encode(whole)}"`), ctx);
  });
}

/** Raw Jinja2 (full doc or fragment) -> filled, GrapesJS-safe, round-trippable HTML. */
export function toFilled(raw: string, sample: SampleData): string {
  let s = raw;
  s = maskOpaque(s);
  s = expandLoops(s, sample as Ctx);
  s = collapseIfs(s, sample as Ctx);
  s = fillInline(s, sample as Ctx);
  return s;
}
