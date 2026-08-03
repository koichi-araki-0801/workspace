// =============================================================================
// canvasActiveContent.guard.test.ts — 編集 canvas に能動コンテンツを入れないガード
// =============================================================================
// 編集 canvas の iframe は `about:blank` でアプリのオリジンを継承し、GrapesJS が親から
// 中の DOM を直接操作する都合で `sandbox` を付けられない。つまり canvas に入った要素は
// アプリと同一オリジンで動く。draft HTML は「保存できる誰か」が書けるため、承認者が
// `/edit/:id` を開いた瞬間に相手の権限でスクリプトが走る経路になりうる(所見 F39)。
//
// 守りは 2 層で、このファイルは両方を検証する:
//   1. 純関数 `pruneCanvasActiveContent` — 何を落とし、何を残すか。
//   2. `useGrapes.init` の `parse:html:root` 配線 — 実際の GrapesJS 経由で効いていること。
// 2 が要点で、GrapesJS 既定のサニタイズが素通りさせる `<iframe srcdoc>` を実測で押さえる。
import { beforeEach, describe, expect, it } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';
import { type ParsedHtmlNode, pruneCanvasActiveContent } from '@/lib/sanitizeHtml';

/** 属性だけを持つ最小の element node。 */
function el(tagName: string, attributes: Record<string, string> = {}): ParsedHtmlNode {
  return { tagName, attributes };
}

describe('pruneCanvasActiveContent', () => {
  it('自前の browsing context を作る要素を子ごと落とす', () => {
    const root: ParsedHtmlNode = {
      childNodes: [
        el('IFRAME', { srcdoc: '<script>top.fetch("/api/users")</script>' }),
        el('OBJECT', { data: 'x.swf' }),
        el('EMBED', { src: 'x.swf' }),
        el('P', { class: 'keep' }),
      ],
    };
    pruneCanvasActiveContent(root);
    expect(root.childNodes?.map((n) => n.tagName)).toEqual(['P']);
  });

  it('入れ子の奥にある iframe も落とす', () => {
    const inner = el('IFRAME', { srcdoc: '<script>1</script>' });
    const root: ParsedHtmlNode = {
      childNodes: [{ tagName: 'DIV', childNodes: [{ tagName: 'TD', childNodes: [inner] }] }],
    };
    pruneCanvasActiveContent(root);
    expect(root.childNodes?.[0].childNodes?.[0].childNodes).toEqual([]);
  });

  it('`on*` ハンドラ属性を大文字混じりでも落とす', () => {
    const node = el('P', { onclick: 'alert(1)', ONERROR: 'alert(2)', onmouseover: 'x' });
    pruneCanvasActiveContent({ childNodes: [node] });
    expect(node.attributes).toEqual({});
  });

  it('GrapesJS が取りこぼす `javascript:` の変形を URL 属性から落とす', () => {
    // GrapesJS 側の判定は素の `startsWith('javascript:')` で、先頭空白・改行・大文字は通る。
    const node = el('A', {
      href: ' \n JavaScript:alert(1)',
      formaction: 'vbscript:msgbox',
      'xlink:href': 'javascript:alert(2)',
    });
    pruneCanvasActiveContent({ childNodes: [node] });
    expect(node.attributes).toEqual({});
  });

  it('レポートが実際に使うマークアップは 1 つも削らない', () => {
    const node = el('IMG', {
      src: 'data:image/png;base64,AAAA',
      class: 'chart',
      style: 'width:10mm',
      'data-part-id': 'p1',
      'data-jinja-open': 'e3sgZm9yIH19',
    });
    const link = el('A', { href: '{{ fund.url }}', title: 'javascript: の解説' });
    const root: ParsedHtmlNode = { childNodes: [node, link] };
    pruneCanvasActiveContent(root);
    expect(root.childNodes).toHaveLength(2);
    expect(node.attributes).toEqual({
      src: 'data:image/png;base64,AAAA',
      class: 'chart',
      style: 'width:10mm',
      'data-part-id': 'p1',
      'data-jinja-open': 'e3sgZm9yIH19',
    });
    // URL 属性以外(`title`)は本文でしかないので、字面が一致しても触らない。
    expect(link.attributes).toEqual({ href: '{{ fund.url }}', title: 'javascript: の解説' });
  });

  it('子も属性も無い node を素通しする(再帰の終端)', () => {
    const bare: ParsedHtmlNode = { tagName: 'BR' };
    pruneCanvasActiveContent(bare);
    expect(bare).toEqual({ tagName: 'BR' });
  });
});

describe('useGrapes の canvas 投入経路', () => {
  let g: ReturnType<typeof useGrapes>;

  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
  });

  it('draft 由来の能動コンテンツを canvas モデルへ入れない', () => {
    g.load(
      '<div class="page"><p onclick="alert(1)">本文</p>' +
        '<iframe srcdoc="&lt;script&gt;top.fetch(\'/api/users\')&lt;/script&gt;"></iframe>' +
        '<script>alert(2)</script>' +
        '<a href=" JavaScript:alert(3)">link</a></div>',
      '',
    );
    const html = g.getBodyHtml();
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/srcdoc/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('同じ経路で通常のレポート本文は保たれる', () => {
    // 表・Jinja chip・パーツ ID はレポート本文と保存 round-trip の要。刈り取りが構造や
    // `data-*` を巻き込んでいないことを、同じ `load` 経路で確かめる。
    const body =
      '<div class="page" data-part-id="p1"><table class="t"><tr>' +
      '<td><span class="jinja-chip jinja-var" data-jinja="e3sgYSB9fQ==">{{ a }}</span></td>' +
      '</tr></table><a href="{{ fund.url }}">目論見書</a></div>';
    g.load(body, '');
    const html = g.getBodyHtml();
    expect(html).toContain('data-part-id="p1"');
    expect(html).toContain('<table class="t">');
    expect(html).toContain('data-jinja="e3sgYSB9fQ=="');
    expect(html).toContain('href="{{ fund.url }}"');
    expect(html).toContain('目論見書');
  });
});
