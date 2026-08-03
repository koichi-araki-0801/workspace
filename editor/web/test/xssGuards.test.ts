// =============================================================================
// xssGuards.test.ts — 承認者/閲覧者のブラウザで申請者の HTML/CSS を実行させない
// =============================================================================
// 差分・比較画面は他ユーザ(申請者)が書いたテンプレ HTML/CSS を描画する。ここが素通しだと
// 承認者のブラウザ上・アプリと同一オリジンでスクリプトが走り、職務分掌(自己承認拒否)を
// 実質回避できる。守りは 3 枚あり、このファイルはそのうち 2 枚を検証する:
//   1. iframe の `sandbox`      → `iframeSandbox.guard.test.ts`
//   2. HTML のサニタイズ         → `compareService` の描画結果
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
  const EVIL = `<!doctype html><html><body>
    <p onclick="alert(1)">click</p>
    <script>alert('xss')</script>
    <img src=x onerror="alert(2)">
    <a href="javascript:alert(3)">link</a>
  </body></html>`;

  /** 攻撃者の本文をそのまま返す最小のリポジトリ。描画経路だけを見たいので他は使わない。 */
  const templates = {
    getTemplate: async () =>
      ok({ meta: { attributes: { fundCode: '510037' } }, html: EVIL, css: '' }),
    getSampleData: async () => ok({ fund: { code: '510037' } }),
  };
  const history = {
    getSnapshot: async () => ok({ html: EVIL, css: '', fundCode: '510037' }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: テストダブルは必要な 3 メソッドだけを持つ。
  const service = createCompareService(templates as any, history as any);

  /** 能動コンテンツ(script / on* / javascript: URL)が 1 つも残っていないこと。 */
  function expectInert(html: string): void {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror\s*=/i);
    expect(html).not.toMatch(/onclick\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  }

  it('strips active content from the current version (baseline path)', async () => {
    const res = await service.renderVersionHtml(`baseline:${TEMPLATE_ID}`);
    expect(res.ok).toBe(true);
    if (res.ok) expectInert(res.value.html);
  });

  it('strips active content from a confirmed snapshot', async () => {
    const res = await service.renderVersionHtml('some-history-id');
    expect(res.ok).toBe(true);
    if (res.ok) expectInert(res.value.html);
  });

  it('strips active content from a submitted body (approval screen)', async () => {
    const res = await service.renderTemplateBody(EVIL, '', '510037');
    expect(res.ok).toBe(true);
    if (res.ok) expectInert(res.value.html);
  });

  it('keeps the report markup that the diff relies on', async () => {
    // サニタイズが構造まで削ると差分が壊れる。無害なマークアップは残ることを確かめる。
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
