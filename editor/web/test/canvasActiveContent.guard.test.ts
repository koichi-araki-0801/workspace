// =============================================================================
// canvasActiveContent.guard.test.ts — 編集 canvas 入口の許可リスト刈り取りガード
// =============================================================================
// 編集 canvas の iframe は `about:blank` でアプリのオリジンを継承し、GrapesJS が親から
// 中の DOM を直接操作する。つまり canvas に入った要素はアプリと同一オリジンで動く。
// draft HTML は「保存できる誰か」が書けるため、承認者が `/edit/:id` を開いた瞬間に
// 相手の権限でスクリプトが走る経路になりうる。
//
// **守りは許可リストである。** 前回は危険物を列挙する形(iframe/object/embed/frame/frameset
// + `on*` + `javascript:`)で、GrapesJS の **prop チャネル**(`data-gjs-*`)を 1 つも見て
// いなかった。属性名を検査する型の防御は、prop になった時点で別の空間へ移るため原理的に
// 届かない。以下は 1 ケース 1 迂回で「その入力が失敗すること」を主張する。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { JINJA_COMPONENT_TYPE_SET } from '@/features/editor/jinjaComponents';
import { useGrapes } from '@/features/editor/useGrapes';
import { type ParsedHtmlNode, pruneCanvasActiveContent } from '@/lib/sanitizeHtml';
import { getBodyInner } from '@/lib/templateDoc';

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

const OPTS = { allowedGjsTypes: JINJA_COMPONENT_TYPE_SET };

/** 属性だけを持つ最小の element node(GrapesJS の `ParsedNode` と構造的に同じ形)。 */
function el(tagName: string, attributes: Record<string, string> = {}): ParsedHtmlNode {
  return { nodeType: ELEMENT, tagName, attributes };
}

/** SVG 名前空間の element node。 */
function svg(tagName: string, attributes: Record<string, string> = {}): ParsedHtmlNode {
  return { nodeType: ELEMENT, namespaceURI: SVG_NS, tagName, attributes };
}

/** 1 要素を刈って、その要素に残った属性を返す。 */
function prunedAttrs(node: ParsedHtmlNode): Record<string, string> {
  pruneCanvasActiveContent({ childNodes: [node] }, OPTS);
  return node.attributes ?? {};
}

/** 子要素を刈って、残ったタグ名の列を返す。 */
function keptTags(...kids: ParsedHtmlNode[]): Array<string | undefined> {
  const root: ParsedHtmlNode = { childNodes: kids };
  pruneCanvasActiveContent(root, OPTS);
  return (root.childNodes ?? []).map((n) => n.tagName);
}

describe('pruneCanvasActiveContent — prop チャネル(data-gjs-*)', () => {
  // GrapesJS は `data-gjs-script` を component prop `script` として model に載せ、
  // `ComponentView.render` が `document.createElement('script')` + `innerHTML` で
  // canvas frame の body へ append する。名前は `on` で始まらず値も `javascript:` でない。
  it('data-gjs-script が落ちる', () => {
    expect(prunedAttrs(el('DIV', { 'data-gjs-script': 'alert(1)' }))).toEqual({});
  });

  it('data-gjs-SCRIPT(大文字)も落ちる', () => {
    // 捕まえるのは小文字化した名前で広く、通すのは元の名前が正確に一致するものだけ。
    expect(prunedAttrs(el('DIV', { 'data-gjs-SCRIPT': 'alert(1)' }))).toEqual({});
  });

  it('data-gjs-attributes が属性ごと落ちる', () => {
    // 「`onerror` が残らない」ではなく「prop 自体が無い」を主張する。JSON を parse して
    // 中身を検査する設計は採らない — 自分の解釈と GrapesJS の解釈がズレた瞬間に穴になる。
    expect(prunedAttrs(el('IMG', { 'data-gjs-attributes': '{"onerror":"alert(1)"}' }))).toEqual({});
  });

  it('data-gjs-content が落ちる', () => {
    expect(prunedAttrs(el('DIV', { 'data-gjs-content': '<img src=x onerror=alert(1)>' }))).toEqual(
      {},
    );
  });

  it('data-gjs-tagName で要素を差し替える経路が落ちる', () => {
    // `parseNode` が埋めた `model.tagName` を `parseNodeAttr` が上書きするため、
    // `<span data-gjs-tagName="iframe">` は実 iframe になる。
    expect(prunedAttrs(el('SPAN', { 'data-gjs-tagName': 'iframe' }))).toEqual({});
    expect(prunedAttrs(el('SPAN', { 'data-gjs-tagName': 'script' }))).toEqual({});
  });

  it('data-gjs-components の JSON で子を丸ごと差し込む経路が落ちる', () => {
    // `model.components` が埋まっていると `parseNode` は子の走査ごとスキップするため、
    // JSON で書いた component 定義がそのまま採用される(刈り取りは JSON の中へ届かない)。
    const attrs = prunedAttrs(
      el('DIV', { 'data-gjs-components': '[{"tagName":"script","content":"alert(1)"}]' }),
    );
    expect(attrs).toEqual({});
  });

  it('未知の prop も落ちる(列挙ではなく許可リストであることの証明)', () => {
    expect(prunedAttrs(el('DIV', { 'data-gjs-foobar': 'x', 'data-gjs-void': 'true' }))).toEqual({});
  });

  it('data-gjs-type="iframe" は属性ごと落ちるが要素は残る', () => {
    const node = el('SPAN', { 'data-gjs-type': 'iframe', class: 'keep' });
    expect(prunedAttrs(node)).toEqual({ class: 'keep' });
  });

  it('data-gjs-type="jinja-var" は残る(編集 2 系統の chip が壊れない)', () => {
    const node = el('SPAN', { 'data-gjs-type': 'jinja-var', 'data-jinja': 'e3sgYSB9fQ==' });
    expect(prunedAttrs(node)).toEqual({
      'data-gjs-type': 'jinja-var',
      'data-jinja': 'e3sgYSB9fQ==',
    });
  });

  it.each([
    'JINJA-VAR',
    'jinja-var ',
    ' jinja-var',
    `jinja-var${String.fromCharCode(0)}`, // 末尾 NUL
  ])('data-gjs-type の値は完全一致でしか通さない: %j', (value) => {
    expect(prunedAttrs(el('SPAN', { 'data-gjs-type': value }))).toEqual({});
  });

  it('許可する型は jinjaComponents の登録と同一の集合から来る', () => {
    // 型を足したときに `addType` と刈り取りの片方だけが更新される事故を落とす。
    expect([...JINJA_COMPONENT_TYPE_SET].sort()).toEqual([
      'jinja-comment',
      'jinja-math',
      'jinja-script',
      'jinja-stmt',
      'jinja-var',
    ]);
  });
});

describe('pruneCanvasActiveContent — 要素と属性の許可リスト', () => {
  it('自前の browsing context を作る要素を子ごと落とす', () => {
    expect(
      keptTags(
        el('IFRAME', { srcdoc: '<script>top.fetch("/api/users")</script>' }),
        el('OBJECT', { data: 'x.swf' }),
        el('EMBED', { src: 'x.swf' }),
        el('P', { class: 'keep' }),
      ),
    ).toEqual(['P']);
  });

  it('入れ子の奥にある iframe も落とす', () => {
    const inner = el('IFRAME', { srcdoc: '<script>1</script>' });
    const root: ParsedHtmlNode = {
      childNodes: [
        {
          nodeType: ELEMENT,
          tagName: 'DIV',
          childNodes: [{ nodeType: ELEMENT, tagName: 'TD', childNodes: [inner] }],
        },
      ],
    };
    pruneCanvasActiveContent(root, OPTS);
    expect(root.childNodes?.[0].childNodes?.[0].childNodes).toEqual([]);
  });

  it('SMIL(animate 系)を subtree ごと落とす', () => {
    // `<a><animate attributeName="href" to="javascript:…">` は要素名も属性名も旧判定に
    // 掛からないまま任意 JS 実行へ到達できる。
    expect(
      keptTags(
        svg('animate', { attributeName: 'href', to: 'javascript:alert(1)' }),
        svg('set', { to: 'javascript:alert(1)' }),
        svg('animateTransform', {}),
        svg('circle', { cx: '1' }),
      ),
    ).toEqual(['circle']);
  });

  it('meta / base / link を落とす(宣言的リフレッシュと外部参照)', () => {
    expect(
      keptTags(
        el('META', { 'http-equiv': 'refresh', content: '0;url=http://evil.example/' }),
        el('BASE', { href: 'http://evil.example/' }),
        el('LINK', { rel: 'stylesheet', href: 'http://evil.example/x.css' }),
        el('P'),
      ),
    ).toEqual(['P']);
  });

  it('template / noscript / foreignObject / math を落とす', () => {
    expect(
      keptTags(el('TEMPLATE'), el('NOSCRIPT'), svg('foreignObject'), el('MATH'), el('SPAN')),
    ).toEqual(['SPAN']);
  });

  it('`on*` ハンドラ属性を大文字混じりでも落とす(許可リストに無いから落ちる)', () => {
    const attrs = prunedAttrs(
      el('P', { onclick: 'alert(1)', ONERROR: 'alert(2)', onmouseover: 'x', class: 'keep' }),
    );
    expect(attrs).toEqual({ class: 'keep' });
  });

  it.each([
    ' \n JavaScript:alert(1)',
    'vbscript:msgbox',
    'dAta:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload=alert(1)></svg>',
    '//evil.example/x',
    'file:///etc/passwd',
  ])('スキーム許可リストに無い URL 値を落とす: %j', (href) => {
    expect(prunedAttrs(el('A', { href }))).toEqual({});
  });

  it.each([
    '{{ fund.url }}',
    '#note1',
    'css/a.css',
    'https://example.com/x',
    'mailto:a@example.com',
    'data:image/png;base64,AAAA',
  ])('自己完結・Jinja・許可スキームの URL 値は残す: %j', (href) => {
    expect(prunedAttrs(el('A', { href }))).toEqual({ href });
  });

  it('レポートが実際に使うマークアップは 1 つも削らない', () => {
    const img = el('IMG', {
      src: 'data:image/png;base64,AAAA',
      class: 'chart',
      style: 'width:10mm',
      'data-part-id': 'p1',
      'data-jinja-open': 'e3sgZm9yIH19',
    });
    const link = el('A', { href: '{{ fund.url }}', title: 'javascript: の解説' });
    expect(keptTags(img, link)).toEqual(['IMG', 'A']);
    expect(img.attributes).toEqual({
      src: 'data:image/png;base64,AAAA',
      class: 'chart',
      style: 'width:10mm',
      'data-part-id': 'p1',
      'data-jinja-open': 'e3sgZm9yIH19',
    });
    // URL 属性以外(`title`)は本文でしかないので、字面が一致しても触らない。
    expect(link.attributes).toEqual({ href: '{{ fund.url }}', title: 'javascript: の解説' });
  });

  // 「Jinja トークンで始まるなら無条件で通す」としていた版は、トークンを前置するだけで
  // 危険なスキームを通した。テンプレは描画されてから使われるので、描画後の href は
  // `javascript:alert(1)` になる。トークンを空へ潰した残りでも判定する。
  it.each([
    "{{''}}javascript:alert(1)",
    '{% if x %}{% endif %}javascript:alert(1)',
    '{# c #}JavaScript:alert(1)',
    "{{''}}data:text/html,<script>1</script>",
  ])('Jinja トークンを前置した危険な URL を落とす: %s', (href) => {
    const link = el('A', { href });
    expect(keptTags(link)).toEqual(['A']);
    expect(link.attributes).toEqual({});
  });

  it('テキスト・コメントノードを消さない(許可リスト反転の実装罠)', () => {
    // `tagName` の無いノードは「許可リストに無い」判定へ落ちるため、`nodeType` を先に
    // 見る分岐が無いとテキストが全滅する。
    const root: ParsedHtmlNode = {
      childNodes: [{ nodeType: TEXT }, { nodeType: COMMENT }, el('P'), { nodeType: TEXT }],
    };
    pruneCanvasActiveContent(root, OPTS);
    expect(root.childNodes).toHaveLength(4);
  });

  it('子も属性も無い node を素通しする(再帰の終端)', () => {
    const bare: ParsedHtmlNode = { nodeType: ELEMENT, tagName: 'BR' };
    pruneCanvasActiveContent(bare, OPTS);
    expect(bare).toEqual({ nodeType: ELEMENT, tagName: 'BR' });
  });

  it('落とした件数と名前を返す(黙って消さない)', () => {
    const report = pruneCanvasActiveContent(
      { childNodes: [el('IFRAME'), el('P', { onclick: 'x', 'data-gjs-script': 'y' })] },
      OPTS,
    );
    expect(report.droppedCount).toBe(3);
    expect(report.droppedElements).toEqual(['iframe']);
    expect(report.droppedAttrs.sort()).toEqual(['data-gjs-script', 'onclick']);
  });
});

// 許可リストが狭すぎると、既に保存されているテンプレを開いたときに中身が静かに欠ける。
// fixtures/parts に新しいタグ・属性が入ったら CI が落ちるよう、census を常設する。
describe('canvas 語彙の census(許可リストが実テンプレを削らない)', () => {
  const FIXTURES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/api/fixtures',
  );

  /** 実 DOM でパースして GrapesJS の `ParsedNode` 相当へ写す。 */
  function toParsed(node: Node): ParsedHtmlNode {
    const out: ParsedHtmlNode = { nodeType: node.nodeType };
    if (node.nodeType === ELEMENT) {
      const e = node as Element;
      out.tagName = e.tagName;
      out.namespaceURI = e.namespaceURI ?? undefined;
      out.attributes = Object.fromEntries(Array.from(e.attributes).map((a) => [a.name, a.value]));
    }
    const kids = Array.from(node.childNodes);
    if (kids.length > 0) out.childNodes = kids.map(toParsed);
    return out;
  }

  function bodies(): Array<{ label: string; html: string }> {
    const out: Array<{ label: string; html: string }> = [];
    for (const sub of ['filled', 'templates']) {
      const dir = path.join(FIXTURES, sub);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.html')) continue;
        // canvas へ入るのは `<body>` の inner だけ(`templateEditorService.loadForEdit`)。
        // head の `meta`/`link`/`title` は許可リストに無いが、そもそも canvas へ届かない。
        const raw = readFileSync(path.join(dir, name), 'utf8');
        out.push({ label: `${sub}/${name}`, html: getBodyInner(raw) });
      }
    }
    const parts = JSON.parse(readFileSync(path.join(FIXTURES, 'parts.json'), 'utf8')) as Array<{
      id: string;
      content?: string;
    }>;
    for (const p of parts) {
      if (typeof p.content === 'string') out.push({ label: `parts/${p.id}`, html: p.content });
    }
    return out;
  }

  const CASES = bodies();

  it('走査対象を実際に見つけている(セルフテスト)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(CASES.map((c) => [c.label, c.html]))('%s を 1 件も削らない', (_label, html) => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const report = pruneCanvasActiveContent(toParsed(doc.body), OPTS);
    expect({
      elements: report.droppedElements,
      attrs: report.droppedAttrs,
    }).toEqual({ elements: [], attrs: [] });
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

  it('prop チャネル経由の script が保存 HTML へ出ない(jsInHtml も含む二重防御)', () => {
    // 刈り取りが効いていれば prop はそもそも載らないが、`jsInHtml:false` を外すと
    // `getHtml()` が component の script を `<script>` として連結して返す。
    g.load('<div data-gjs-script="top.fetch(\'/api/users\')">x</div>', '');
    expect(g.getBodyHtml()).not.toMatch(/<script/i);
    expect(g.getBodyHtml()).not.toMatch(/data-gjs-script/i);
  });

  it('同じ経路で通常のレポート本文は保たれる', () => {
    // 表・Jinja chip・パーツ ID はレポート本文と保存 round-trip の要。刈り取りが構造や
    // `data-*` を巻き込んでいないことを、同じ `load` 経路で確かめる。
    const body =
      '<div class="page" data-part-id="p1"><table class="t"><tr>' +
      '<td><span class="jinja-chip jinja-var" data-gjs-type="jinja-var" data-jinja="e3sgYSB9fQ==">{{ a }}</span></td>' +
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
