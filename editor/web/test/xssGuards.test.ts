// =============================================================================
// xssGuards.test.ts — 承認者/閲覧者のブラウザで申請者の HTML/CSS を実行させない
// =============================================================================
// 差分・比較画面は他ユーザ(申請者)が書いたテンプレ HTML/CSS を描画する。ここが素通しだと
// 承認者のブラウザ上・アプリと同一オリジンでスクリプトが走り、職務分掌(自己承認拒否)を
// 実質回避できる。
//
// **守り方は「除去」ではなく「隔離」である。** テンプレの JS は開発者が生成時に埋め込む
// 正当なコンテンツで、落とすと承認者は「JS が効いていない見た目」を承認してしまう。
// よって守りは次の 3 枚で、このファイルは 2・3 を検証する:
//   1. iframe の `sandbox="allow-scripts"`(same-origin なし) → `iframeSandbox.guard.test.ts`
//   2. 描画経路が能動コンテンツを**保持**すること(承認対象を痩せさせない)
//   3. CSS のコンテキスト脱出封じ → `sanitizeStyleContent` / `buildDiffDoc`
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { buildDiffDoc } from '@/features/compare/htmlBlockDiff';
import { createCompareService } from '@/features/compare/services/compareService';
import { findExternalRefsInCss, sanitizeStyleContent, styleTag } from '@/lib/sanitizeCss';
import { appendPreviewStyle, sanitizePreviewRoot, stripExternalRefs } from '@/lib/sanitizeHtml';

describe('sanitizeStyleContent', () => {
  it('neutralises a </style> escape so the element cannot be closed', () => {
    const evil = 'body{}</style><script>alert(1)</script><style>';
    const out = sanitizeStyleContent(evil);
    expect(out).not.toMatch(/<\/style/i);
    expect(out).toContain('<\\/style>');
  });

  it('catches case and whitespace variants the HTML parser still honours', () => {
    // HTML の raw text 終端判定は大文字小文字を区別せず、`</style` の直後は空白でもよい。
    for (const evil of ['</STYLE>', '</Style >', '</style\n>', '</style/']) {
      expect(sanitizeStyleContent(evil)).not.toMatch(/<\/style/i);
    }
  });

  it('leaves ordinary CSS byte-identical', () => {
    const css = 'body { margin: 0 } .a::after { content: "a/b" } @media print { .b { x: 1 } }';
    expect(sanitizeStyleContent(css)).toBe(css);
  });

  it('escapes a breakout hidden inside a CSS string literal', () => {
    // CSS 文字列の内側でも HTML パーサは `</style` で閉じてしまうため、ここも潰す必要がある。
    const css = '.a::after{content:"</style><img src=x onerror=alert(1)>"}';
    expect(sanitizeStyleContent(css)).not.toMatch(/<\/style/i);
  });

  it('styleTag wraps the sanitised content and keeps attributes', () => {
    expect(styleTag('a{}', 'data-preview-css')).toBe('<style data-preview-css>a{}</style>');
  });
});

// CSS の外部参照は「削る」ではなく「拒む」。削る実装(正規表現)は CSS のエスケープで必ず
// 迂回されるため、以下のエスケープ難読化ケースが実装方式そのものを機械検証している。
describe('findExternalRefsInCss', () => {
  it.each([
    '@import url(http://evil.example/x.css);',
    '@import "http://evil.example/x.css";',
    '@IMPORT url(http://evil.example/x.css);',
    '@\\69 mport url(http://evil.example/x.css);',
    '.a{background:url(http://evil.example/y.png)}',
    '.a{background:url(\\68ttp://evil.example/y.png)}',
    '.a{background:url( "https://evil.example/y.png" )}',
    '.a{background:url(//evil.example/y.png)}',
    '@font-face{src:url(https://evil.example/f.woff2)}',
    '@media print{@import url(http://evil.example/x.css);}',
    '.a{background:image-set(url(http://evil.example/y.png) 1x)}',
    // 引用符文字列で URL を取る CSS 関数。`url(` を探す実装だとここが素通りした
    // (Chromium は image-set / -webkit-image-set のどちらも実際に取得しに行く)。
    '.a{background-image:image-set("http://evil.example/x.png" 1x)}',
    '.a{background-image:-webkit-image-set("http://evil.example/x.png" 1x)}',
    '.a{background-image:image-set("//evil.example/x.png" 1x)}',
    '.a{src:local("http://evil.example/f.woff2")}',
    // SVG は文脈次第でスクリプトを持ち込むため data:image/svg+xml も許可しない。
    '.a{background:url("data:image/svg+xml,<svg onload=alert(1)></svg>")}',
  ])('外部参照を検出する: %s', (css) => {
    expect(findExternalRefsInCss(css).length).toBeGreaterThan(0);
  });

  it.each([
    '.a{background:url(img/a.png)}',
    '.a{background:url("../shared/a.png")}',
    '.a{background:url(#grad)}',
    '.a{background:url(data:image/png;base64,AAAA)}',
    '@font-face{src:url(data:font/woff2;base64,AAAA)}',
    '.a::after{content:"@import url(http://evil.example/x)"}',
    '/* @import url(http://evil.example/x) */ .a{color:red}',
    '@media print{.a{color:red}} @supports (a:b){.b{}} @page{margin:0} @charset "utf-8";',
    // CSS Paged Media のマージンボックス。ページ番号を印字するだけのごく普通の
    // テンプレ CSS で、拒むと PDF タブが恒久的に失敗する(しかも文言が不一致)。
    '@page{size:A4;@bottom-center{content:counter(page);font-size:8pt}}',
    '@page{@top-left-corner{content:""}@right-middle{content:""}@left-bottom{content:""}}',
    '.a{content:"注: 説明"}',
    '.b{font-family:"BIZ UDPGothic"}',
  ])('誤検出しない: %s', (css) => {
    expect(findExternalRefsInCss(css)).toEqual([]);
  });

  it.each([
    // 引用符文字列の中のエスケープ、`\` が入力末尾、16 進でないエスケープ、`url()` の
    // 引用符付き形。いずれもトークナイザの分岐で、正規表現実装だと素通りする経路。
    ['.a{background:url("http\\3a //evil.example/x")}', true],
    ['.a::after{content:"\\"@import url(http://evil.example/x)"}', false],
    ['.a{background:url(\\', false],
    // エスケープ解決は許可側にも効く: `\-webkit-keyframes` は許可リストの名前と一致する。
    ['@\\-webkit-keyframes x{}', false],
  ])('トークナイザの端の入力を取りこぼさない: %j', (css, expectFound) => {
    expect(findExternalRefsInCss(css).length > 0).toBe(expectFound);
  });

  it('現行の全ファンド CSS が誤検出ゼロで通る', () => {
    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/api/fixtures/css',
    );
    const files = readdirSync(dir).filter((n) => n.endsWith('.css'));
    // 0 件だと以下の forEach が素通りして「常に緑」になるため、下限を固定する。
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const name of files) {
      expect(findExternalRefsInCss(readFileSync(path.join(dir, name), 'utf8')), name).toEqual([]);
    }
  });
});

describe('プレビュー文書の DOM 組み立てプリミティブ', () => {
  it('sanitizePreviewRoot は素の <link rel=stylesheet> を残さない(後段の除去に頼らない)', () => {
    // DOMPurify の版更新で既定の許可リストが変わったら、ここが落ちて検知できる。
    const root = sanitizePreviewRoot(
      '<html><head><link rel=stylesheet href=a.css><base href="http://evil/"></head><body>x</body></html>',
    );
    expect(root.querySelectorAll('link')).toHaveLength(0);
    expect(root.querySelectorAll('base')).toHaveLength(0);
  });

  it('stripExternalRefs は <template> の中の外部参照も落とす', () => {
    // `querySelectorAll` は template content へ降りないため、明示的に走査していないと素通りする。
    const doc = new DOMParser().parseFromString(
      '<html><head></head><body><template><link rel=stylesheet href=a.css>' +
        '<meta http-equiv="refresh" content="0;url=http://evil/"></template></body></html>',
      'text/html',
    );
    const removed = stripExternalRefs(doc.documentElement);
    expect(removed).toBe(2);
    const tpl = doc.querySelector('template') as HTMLTemplateElement;
    expect(tpl.content.querySelectorAll('link, meta')).toHaveLength(0);
  });

  it('appendPreviewStyle は CSS を textContent として入れる(置換の特殊解釈が起きない)', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head></head><body></body></html>',
      'text/html',
    );
    const style = appendPreviewStyle(doc.documentElement, '.a{content:"$& $\' $`"}', {
      'data-x': '',
    });
    expect(style.textContent).toBe('.a{content:"$& $\' $`"}');
    expect(style.parentElement?.tagName).toBe('HEAD');
  });

  it('appendPreviewStyle は head が無い文書へも head を作って足す', () => {
    // 素の `<html>` 要素を組んで head 欠落を再現する(DOMParser は必ず head を補うため)。
    const doc = new DOMParser().parseFromString('<html></html>', 'text/html');
    const root = doc.createElement('html');
    root.appendChild(doc.createElement('body'));
    const style = appendPreviewStyle(root, '.a{}');
    expect(style.parentElement?.tagName).toBe('HEAD');
    expect(root.firstElementChild?.tagName).toBe('HEAD');
  });
});

describe('buildDiffDoc', () => {
  it('does not let attacker CSS close the style element', () => {
    const src = buildDiffDoc('<p>body</p>', 'x{}</style><script>alert(1)</script>', '.hl{}');
    // 生成文書に残る `</style>` は、こちらが閉じた分だけであるべき(style 要素は 2 つ)。
    expect(src.match(/<\/style>/gi)?.length).toBe(2);
    // 実際にパースして確かめる。`<script>` の字面はスタイル本文として残るが、それは
    // 「閉じられなかったので CSS の一部のまま」という意味であって、要素にはならない。
    const doc = new DOMParser().parseFromString(src, 'text/html');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelectorAll('style')).toHaveLength(2);
    expect(doc.querySelector('style')?.textContent).toContain('<script>alert(1)</script>');
  });

  // `buildDiffDoc` は「自分で用意した器へ、既に安全化した素材を詰める」= *包む*だけなので
  // 文字列組み立てのままでよい。ここへアンカー探索(`</head>` を探して足す)や部分除去を
  // 1 行でも入れると、その瞬間に `nunjucksRender` と同じ穴になる。
  it('fragment に </head> や <link rel=stylesheet> の字面があっても文書構造が壊れない', () => {
    const src = buildDiffDoc('<p title="</head><link rel=stylesheet>">x</p>', 'a{}', '.hl{}');
    const doc = new DOMParser().parseFromString(src, 'text/html');
    expect(doc.head.querySelectorAll('style')).toHaveLength(2);
    expect(doc.head.querySelectorAll('link')).toHaveLength(0);
    expect(doc.querySelector('body > p')?.textContent).toBe('x');
  });
});

describe('compareService の描画結果', () => {
  const TEMPLATE_ID = 'AM01_510037_20240710_交付版';
  const ACTIVE = `<!doctype html><html><body>
    <p onclick="fit()">click</p>
    <script>col.width=1</script>
    <a href="javascript:go()">link</a>
  </body></html>`;

  /** 攻撃者の本文をそのまま返す最小のリポジトリ。描画経路だけを見たいので他は使わない。 */
  const templates = {
    getTemplate: async () =>
      ok({ meta: { attributes: { fundCode: '510037' } }, html: ACTIVE, css: '' }),
    getSampleData: async () => ok({ fund: { code: '510037' } }),
  };
  const history = {
    getSnapshot: async () => ok({ html: ACTIVE, css: '', fundCode: '510037' }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: テストダブルは必要な 3 メソッドだけを持つ。
  const service = createCompareService(templates as any, history as any);

  /**
   * 能動コンテンツが**残っている**こと。ここを「除去する」へ戻すと、承認者は JS が
   * 効いていない見た目を承認することになり、承認ゲートの意味が失われる(隔離は
   * `sandbox="allow-scripts"` = same-origin なしの iframe が担う)。
   */
  function expectActiveKept(html: string): void {
    expect(html).toMatch(/<script/i);
    expect(html).toMatch(/onclick\s*=/i);
    expect(html).toMatch(/javascript:/i);
  }

  it('keeps active content in the current version (baseline path)', async () => {
    const res = await service.renderVersionHtml(`baseline:${TEMPLATE_ID}`);
    expect(res.ok).toBe(true);
    if (res.ok) expectActiveKept(res.value.html);
  });

  it('keeps active content in a confirmed snapshot', async () => {
    const res = await service.renderVersionHtml('some-history-id');
    expect(res.ok).toBe(true);
    if (res.ok) expectActiveKept(res.value.html);
  });

  it('keeps active content in a submitted body (approval screen)', async () => {
    const res = await service.renderTemplateBody(ACTIVE, '', '510037');
    expect(res.ok).toBe(true);
    if (res.ok) expectActiveKept(res.value.html);
  });

  it('keeps the report markup that the diff relies on', async () => {
    // 構造を削ると差分が壊れる。無害なマークアップがそのまま残ることを確かめる。
    const res = await service.renderTemplateBody(
      '<!doctype html><html><body><table class="t"><tr><td style="width:1px">値</td></tr></table></body></html>',
      '',
      '510037',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.html).toContain('<table class="t">');
      expect(res.value.html).toContain('style="width:1px"');
      expect(res.value.html).toContain('値');
    }
  });
});
