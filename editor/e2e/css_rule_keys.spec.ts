import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldedCssRuleTexts } from '../shared/src/index';
import { KNOWN_UNMATCHED, SYNTHETIC } from '../shared/test/fixtures/cssRuleKeysCorpus';
import { expect, test } from './fixtures';

// =============================================================================
// css_rule_keys.spec.ts — Chromium の GrapesJS の書き出しと原文で CSS 規則のキーがそろうか
// =============================================================================
// `web/test/cssRuleKeys.corpus.dom.test.ts` と同じコーパスを、jsdom ではなく実ブラウザの CSSOM へ
// 通す。ブラウザはセレクタ・値を書き直す(引用符・空白・大文字小文字など)ので、jsdom では
// 見えない食い違いがここで出うる。アプリの画面は使わず、同梱の grapes.min.js を空ページへ
// 載せる。shared は `src` を直に import するため、ビルド済みの dist には依存しない。
// 編集画面と同じ書き出しになるよう、CSS に効く設定(`useGrapes.ts` の init と `getCss`)を写す。

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.resolve(here, '../web/package.json'));
const GRAPES = path.join(path.dirname(req.resolve('grapesjs/package.json')), 'dist/grapes.min.js');
const FIXTURE_DIR = path.resolve(here, '../web/src/api/fixtures/css');

test('Chromium の GrapesJS 0.23.6 の書き出しと原文で CSS 規則のキーがそろう', async ({ page }) => {
  await page.setContent('<div id="gjs"></div>');
  await page.addScriptTag({ path: GRAPES });
  const fixtures = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => [f, fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')] as const);
  const corpus: Record<string, string> = { ...Object.fromEntries(fixtures), ...SYNTHETIC };

  const outs = await page.evaluate((cases) => {
    // biome-ignore lint/suspicious/noExplicitAny: ページ側のグローバル(型を持たない)
    const g = (window as any).grapesjs;
    if (g.version !== '0.23.6') throw new Error(`grapesjs ${g.version}`);
    const ed = g.init({
      container: '#gjs',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      cssIcons: '',
      jsInHtml: false,
      avoidInlineStyle: false,
      forceClass: false,
      protectedCss: '',
    });
    const result: Record<string, string> = {};
    for (const [name, css] of Object.entries(cases)) {
      ed.setComponents('<div></div>');
      ed.setStyle(css);
      // `useGrapes.getCss` と同じく、呼び出しの間だけ avoidInlineStyle を立てる。
      const cfg = ed.getConfig();
      const prev = cfg.avoidInlineStyle;
      cfg.avoidInlineStyle = true;
      try {
        result[name] = ed.getCss({ keepUnusedStyles: true }) ?? '';
      } finally {
        cfg.avoidInlineStyle = prev;
      }
    }
    return result;
  }, corpus);

  for (const [name, css] of Object.entries(corpus)) {
    const rawKeys = new Set(foldedCssRuleTexts(css).keys());
    const missing = [...foldedCssRuleTexts(outs[name] ?? '').keys()].filter((k) => !rawKeys.has(k));
    expect(missing, name).toEqual(KNOWN_UNMATCHED[name] ?? []);
  }
});
