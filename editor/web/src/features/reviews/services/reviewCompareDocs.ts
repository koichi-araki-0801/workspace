// =============================================================================
// reviewCompareDocs.ts — 精査画面の左右組版比較(PreviewPanel×2)へ渡す完全文書
// =============================================================================
// 精査画面の主役は「修正前｜修正後」を実際の帳票と同じ組版(vivliostyle)で並べる比較で、
// 本モジュールは compare サービスが返す本文 HTML + CSS を PreviewPanel が受け取れる
// 完全文書へ包み、変更ブロックへマーカーとアンカーを付ける。
//
// - マーカーは既存の差分装飾と同じ「CSPRNG レイヤ名のカスケードレイヤ + !important」で
//   守る(申請者 CSS は同レイヤ名を当てられない限り上書きできない)。`display` は
//   上書きしない(表セルのレイアウトを壊す)。
// - ここで作る文書は**表示専用**で、申請へ保存されるバイト列(html/css/filledHtml)には
//   一切触れない。DOM 経由の再直列化はこの表示境界だけで行う。
// - 変更ブロックの同定は差分エンジンと同じ `occurrenceKey`(blockKey.ts)を使う。キーの
//   算出規則が割れると「差分一覧では変更なのにマーカーが付かない」ズレになるため、
//   独自の突合を書かない。
import { occurrenceKey } from '@/lib/blockKey';

export interface CompareDocsInput {
  beforeHtml: string;
  afterHtml: string;
  cssBefore: string;
  cssAfter: string;
  /** 変更(changed/added/removed)ブロックのキー集合(`reviewDiffService` の rows 由来)。 */
  changedKeys: ReadonlySet<string>;
  /** 黄マーカーを描くか。false でも位置ジャンプ用のアンカー id は付ける。 */
  marker: boolean;
}

export interface CompareDocs {
  beforeDoc: string;
  afterDoc: string;
  /** after 文書内の出現順のアンカー id(「次の変更箇所へ」の巡回に使う)。 */
  anchors: string[];
}

/** `.page` 直下の top-level block を列挙し、変更キーに一致する要素へ印を付ける。 */
function annotate(
  html: string,
  changedKeys: ReadonlySet<string>,
): { html: string; anchors: string[] } {
  if (!html.trim()) return { html, anchors: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors: string[] = [];
  let seq = 0;
  for (const page of Array.from(doc.querySelectorAll('.page'))) {
    const blocks = Array.from(page.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    for (const el of blocks) {
      if (!changedKeys.has(occurrenceKey(el, blocks))) continue;
      seq += 1;
      const id = `review-anchor-${seq}`;
      el.setAttribute('data-review-marker', '');
      // 既存 id は差分キーの一部でありうるため上書きしない(未設定のときだけ振る)。
      if (!el.id) el.id = id;
      anchors.push(el.id);
    }
  }
  return { html: doc.body.innerHTML, anchors };
}

/** マーカー装飾。レイヤ名は文書ごとに CSPRNG で変え、申請者 CSS からの同名上書きを防ぐ。 */
function markerCss(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const layer = `rvm${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return [
    `@layer ${layer};`,
    `@layer ${layer} {`,
    '[data-review-marker] {',
    '  background-color: #FFF3BF !important;',
    '  outline: 2px solid #E8B931 !important;',
    '  outline-offset: 1px !important;',
    '}',
    '}',
  ].join('\n');
}

function wrapDoc(bodyHtml: string, css: string, marker: boolean): string {
  const markerBlock = marker ? `<style>${markerCss()}</style>` : '';
  // マーカーのレイヤ宣言は申請者 CSS より**前**に出す(重要宣言はレイヤ優先順位が逆転する
  // 性質を使うため、先に宣言した側が勝つ)。
  return `<!doctype html><html><head><meta charset="utf-8">${markerBlock}<style>${css}</style></head><body>${bodyHtml}</body></html>`;
}

export function buildCompareDocs(input: CompareDocsInput): CompareDocs {
  const before = annotate(input.beforeHtml, input.changedKeys);
  const after = annotate(input.afterHtml, input.changedKeys);
  return {
    beforeDoc: wrapDoc(before.html, input.cssBefore, input.marker),
    afterDoc: wrapDoc(after.html, input.cssAfter, input.marker),
    anchors: after.anchors.length > 0 ? after.anchors : before.anchors,
  };
}
