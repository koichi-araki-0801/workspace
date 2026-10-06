// =============================================================================
// editingMarkers.ts — 作成タブの往復用の印が本文に残っていないかを見つける
// =============================================================================
// 値入り HTML(`web/src/lib/fillJinja.ts` の `toFilled` の出力)は、Jinja を戻すための印を
// 本文へ埋める。`toTemplate` がそれを外しきれないまま申請・確定へ進むと、確定テンプレートに
// チップや clone が焼き付く。サーバの関所・検出スクリプト・`toTemplate` の事後検査が同じ
// 定義を使うよう、ここに 1 つだけ置く(定義が分かれると、片側だけ印を足し忘れる)。

export interface EditingMarkerHit {
  marker: string;
  index: number;
}

/** 印の属性名。`web/src/lib/jinjaAttrs.ts` の書き手と対になる。 */
export const EDITING_MARKER_ATTRS = [
  'data-jinja',
  'data-jinja-open',
  'data-jinja-close',
  'data-jinja-block',
  'data-jinja-loop-clone',
  'data-jinja-loop-row',
  'data-opaque',
  'data-opaque-kind',
] as const;

const MARKER_CLASSES = ['jinja-chip', 'jinja-frozen-body'] as const;
const COMMENT_RE = /<!--\s*jinja-rt:/g;
const PLACEHOLDER_RE = /[\u{e000}\u{e001}]/gu;
// 開始タグ 1 個。引用符の中の `>` を読み飛ばす。
const TAG_RE = /<[a-zA-Z][^\s/>]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// 属性 1 個(名前と任意の値)。
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
// 中身が文字データの要素。タグに見える文字列があっても要素ではないので、位置を保ったまま伏せる。
const RAW_TEXT_RE = /<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function maskRawText(html: string): string {
  return html.replace(RAW_TEXT_RE, (m) => m.replace(/[^\n]/g, ' ').replace(/^ /, '<'));
}

export function findEditingMarkers(html: string): EditingMarkerHit[] {
  const hits: EditingMarkerHit[] = [];
  for (const m of html.matchAll(COMMENT_RE))
    hits.push({ marker: 'comment:jinja-rt', index: m.index });
  for (const m of html.matchAll(PLACEHOLDER_RE))
    hits.push({ marker: 'placeholder', index: m.index });
  for (const tag of maskRawText(html).matchAll(TAG_RE)) {
    const attrs = tag[1] ?? '';
    for (const a of attrs.matchAll(ATTR_RE)) {
      const name = (a[1] ?? '').toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      const at = tag.index + 1;
      if ((EDITING_MARKER_ATTRS as readonly string[]).includes(name))
        hits.push({ marker: `attr:${name}`, index: at });
      if (name === 'data-gjs-type' && value.toLowerCase().startsWith('jinja-'))
        hits.push({ marker: 'gjs-type:jinja', index: at });
      if (name === 'class')
        for (const c of MARKER_CLASSES)
          if (value.split(/\s+/).includes(c)) hits.push({ marker: `class:${c}`, index: at });
    }
  }
  return hits.sort((x, y) => x.index - y.index);
}
