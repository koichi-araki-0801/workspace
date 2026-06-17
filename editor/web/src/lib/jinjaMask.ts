/**
 * jinjaMask — convert raw Jinja2 HTML <-> GrapesJS-safe HTML while preserving
 * every `{{ }}` / `{% %}` / `{# #}` tag verbatim.
 *
 * Strategy
 * --------
 * toEditable(raw):
 *   1. "Absorb" simple block statements that wrap a single element with no
 *      nested statement (`{% for %}<tr>…</tr>{% endfor %}`) onto that element as
 *      `data-jinja-open` / `data-jinja-close` (base64). This keeps loop markers
 *      from being foster-parented out of `<table>`/`<tbody>` by the HTML parser.
 *   2. Wrap remaining Jinja that sits in *text* (not inside a tag) as locked
 *      chip elements: `<span data-gjs-type="jinja-…" data-jinja="b64">…</span>`.
 *      The visible label is HTML-escaped; the exact source lives in `data-jinja`.
 *   Jinja inside element attributes (e.g. href="{{ url }}") is left untouched —
 *   attribute values round-trip through GrapesJS verbatim.
 *
 * toTemplate(editable): exact inverse over a parsed DOM. Restored Jinja is first
 * emitted as serialization-safe placeholders and decoded by a final string
 * pass, so characters like `<`, `>`, `&` inside expressions are NOT HTML-escaped
 * by the serializer.
 */

export const TOKEN_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
// Private-use delimiters: survive HTML serialization without being escaped.
export const PH_START = String.fromCharCode(0xe000);
export const PH_END = String.fromCharCode(0xe001);
const PH_RE = new RegExp(`${PH_START}([A-Za-z0-9+/=]*)${PH_END}`, 'g');

export function extractJinjaTokens(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b: string): string {
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function tokenKind(token: string): 'var' | 'stmt' | 'comment' {
  if (token.startsWith('{{')) return 'var';
  if (token.startsWith('{#')) return 'comment';
  return 'stmt';
}

// --- toEditable -------------------------------------------------------------

/**
 * Absorb `{% open … %}<el …>…</el>{% close … %}` onto the wrapped element.
 * The body may not contain any `{% … %}` statement, which keeps `if/else`
 * chains and nested loops out (they fall back to chips) and prevents the match
 * from spanning across `{% else %}`.
 */
function absorbBlocks(html: string, open: string, close: string): string {
  const re = new RegExp(
    `(\\{%\\s*${open}\\b[^%]*%\\})\\s*(<([a-zA-Z][\\w-]*)\\b)((?:[^>]*>)(?:(?!\\{%)[\\s\\S])*?<\\/\\3>)\\s*(\\{%\\s*${close}\\s*%\\})`,
    'g',
  );
  return html.replace(re, (_m, openStmt, tagStart, _tagName, rest, closeStmt) => {
    return `${tagStart} data-jinja-open="${b64encode(openStmt)}" data-jinja-close="${b64encode(closeStmt)}"${rest}`;
  });
}

function wrapInlineTokens(html: string): string {
  // Split into tag (<...>) and text segments; only wrap tokens in text.
  const parts = html.split(/(<[^>]*>)/);
  return parts
    .map((part) => {
      if (part.startsWith('<')) return part; // a tag — leave attributes alone
      return part.replace(TOKEN_RE, (token) => {
        const kind = tokenKind(token);
        return `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-jinja="${b64encode(token)}">${htmlEscape(token)}</span>`;
      });
    })
    .join('');
}

export function toEditable(raw: string): string {
  let s = raw;
  s = absorbBlocks(s, 'for', 'endfor');
  s = absorbBlocks(s, 'if', 'endif');
  s = wrapInlineTokens(s);
  return s;
}

// --- toTemplate -------------------------------------------------------------

export interface ToTemplateOptions {
  /** When true, return only the <body> inner HTML (for GrapesJS body editing). */
  asFragment?: boolean;
}

export function toTemplate(editable: string, opts: ToTemplateOptions = {}): string {
  const hadDoctype = /^\s*<!doctype/i.test(editable);
  const doc = new DOMParser().parseFromString(editable, 'text/html');
  const ph = (enc: string) => doc.createTextNode(`${PH_START}${enc}${PH_END}`);

  // 0. drop loop clones produced by toFilled: only the first (template) row of an
  //    expanded `{% for %}` carries data-jinja-open/close; the filled clones are
  //    display-only and must not survive into the restored template.
  doc.querySelectorAll('[data-jinja-loop-clone]').forEach((el) => {
    el.remove();
  });

  // 1. restore chip spans -> placeholder text
  doc.querySelectorAll('[data-jinja]').forEach((el) => {
    const enc = el.getAttribute('data-jinja');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 1b. restore opaque-masked content — <script>, MathML <math>, and TeX math
  //     (toFilled hides these from GrapesJS as inert chips; the verbatim source
  //     lives in data-opaque).
  doc.querySelectorAll('[data-opaque]').forEach((el) => {
    const enc = el.getAttribute('data-opaque');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 1c. restore a collapsed `{% if %}…{% endif %}` (toFilled keeps only the taken
  //     branch for display; the whole block is preserved in data-jinja-block).
  doc.querySelectorAll('[data-jinja-block]').forEach((el) => {
    const enc = el.getAttribute('data-jinja-block');
    if (enc === null) return;
    el.replaceWith(ph(enc));
  });

  // 2. restore absorbed block statements around their element
  doc.querySelectorAll('[data-jinja-open]').forEach((el) => {
    const open = el.getAttribute('data-jinja-open');
    const close = el.getAttribute('data-jinja-close');
    el.removeAttribute('data-jinja-open');
    el.removeAttribute('data-jinja-close');
    if (open !== null) el.parentNode?.insertBefore(ph(open), el);
    if (close !== null) el.parentNode?.insertBefore(ph(close), el.nextSibling);
  });

  // 3. decode placeholders by raw string substitution (no HTML escaping)
  const serialized = opts.asFragment ? doc.body.innerHTML : doc.documentElement.outerHTML;
  let out = serialized.replace(PH_RE, (_m, enc: string) => b64decode(enc));
  if (!opts.asFragment && hadDoctype) out = `<!doctype html>\n${out}`;
  return out;
}
