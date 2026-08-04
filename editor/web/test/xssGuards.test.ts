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
import { ok } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { buildDiffDoc } from '@/features/compare/htmlBlockDiff';
import { createCompareService } from '@/features/compare/services/compareService';
import { sanitizeStyleContent, styleTag } from '@/lib/sanitizeCss';

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
