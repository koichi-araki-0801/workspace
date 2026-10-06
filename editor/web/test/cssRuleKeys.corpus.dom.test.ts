import { foldedCssRuleTexts, mergeCssRuleChangesFromBaseline, splitCssRules } from '@editor/shared';
import grapesjs from 'grapesjs';
import { describe, expect, it, vi } from 'vitest';
import { useGrapes } from '@/features/editor/useGrapes';
import { KNOWN_UNMATCHED, SYNTHETIC } from '../../shared/test/fixtures/cssRuleKeysCorpus';

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastError: vi.fn() }));

// =============================================================================
// cssRuleKeys.corpus.dom.test.ts — CSS 規則のキーが getCss の書き出しと原文でそろうか
// =============================================================================
// 承認時の変更の検出は、GrapesJS が読み込み直した CSS(baseline)と編集後の CSS を比べ、変わった
// 規則をキーでペア側の原文へ当てる。キーが原文側に無いと、その規則の変更は照合不可の競合になる。
// ここでは実テンプレの CSS と合成ケースを編集画面と同じ経路(`useGrapes` の load → getCss)へ通し、
// getCss 側の全キーが原文側にあることを確かめる。jsdom の CSSOM はセレクタをブラウザのように
// 書き直さないので、確かめられるのは GrapesJS 自身の書き直し(並びの分割・空の規則の省略など)
// まで。ブラウザの書き直しは e2e の Chromium の spec が同じコーパスで確かめる。

const FIXTURES = Object.fromEntries(
  Object.entries(
    import.meta.glob('../src/api/fixtures/css/*.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, css]) => [path.slice(path.lastIndexOf('/') + 1), css]),
);

/** `css` から、照合のキーが `key` の規則を取り除く(GrapesJS の書き出しを編集で消した形)。 */
function withoutRule(css: string, key: string): string {
  let out = css;
  for (const r of splitCssRules(css).reverse()) {
    const alone = r.atRules.reduceRight((inner, at) => `${at}{${inner}}`, r.text);
    if (foldedCssRuleTexts(alone).has(key)) out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out;
}

it('GrapesJS は 0.23.6', () => {
  expect(
    grapesjs.version,
    'GrapesJS を上げたら、このコーパスと既存データへの影響の見積もりを取り直してから期待値を直す',
  ).toBe('0.23.6');
});

describe.each(Object.entries({ ...FIXTURES, ...SYNTHETIC }))('%s', (name, css) => {
  it('getCss の全キーが原文のキーにある(既知の例外は照合不可になる)', () => {
    const g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    try {
      g.load('<div></div>', css);
      const out = g.getCss();
      const rawKeys = new Set(foldedCssRuleTexts(css).keys());
      const outKeys = [...foldedCssRuleTexts(out).keys()];
      // 宣言のある規則が 1 つでもあれば書き出しは空でない(空の書き出しで素通りさせない)。
      if (/\{[^{}]*:/.test(css)) expect(outKeys.length, out).toBeGreaterThan(0);
      const missing = outKeys.filter((k) => !rawKeys.has(k));
      expect(missing, out).toEqual(KNOWN_UNMATCHED[name] ?? []);
      for (const k of missing) {
        const next = withoutRule(out, k);
        expect(foldedCssRuleTexts(next).has(k), next).toBe(false);
        expect(mergeCssRuleChangesFromBaseline(css, out, next, css).unmatched).toContain(k);
      }
    } finally {
      g.destroy();
    }
  });
});
