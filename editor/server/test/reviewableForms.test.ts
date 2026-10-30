// =============================================================================
// reviewableForms.test.ts — 承認画面に出ず本番だけに出る形が、受付で止まるか承認画面に出ること
// =============================================================================
// 第三段の敵対レビュー 3 回の検証スクリプト(probe・probe2・rv3)の全形を 1 つの表にした
// (`reviewableForms.cases.json`)。各行の `prodShows` は、本番相当(Python Jinja2 3.1.6、既定と
// trim_blocks + lstrip_blocks の両方、parse5 で scripting 有効)で印の文字が見えるかで、表を作るときに
// 一度だけ求めて固定した(CI では Python を動かさない)。
// 受付の全体(テンプレの JavaScript の不変の照合 + `renderCreateReview`)を通し、本番で印が見える形は
// 「受付で止まる」か「承認画面(描画結果の DOM の body の文字。右欄の文字の差分と同じ読み方)に印が
// 出る」のどちらかであることを確かめる。
import fs from 'node:fs';
import path from 'node:path';
import { renderCreateReview } from '@editor/shared';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { assertTemplateScriptsUnchanged } from '../src/security/templateScripts.js';

interface FormCase {
  id: string;
  src: string;
  base: string;
  mark: string;
  data?: Record<string, unknown>;
  /** テンプレの JavaScript の不変の照合を通るか(web の `reviewForms.dom.test.ts` が使う。下で一致を確かめる)。 */
  gatePass: boolean;
  prodShows: boolean;
}

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'reviewableForms.cases.json'), 'utf8'),
) as FormCase[];

/** 受付を通す。止まれば理由、通れば描画結果。 */
function submit(c: FormCase): { rejected: string } | { rendered: string } {
  try {
    assertTemplateScriptsUnchanged(c.base, c.src, { templateId: 't', where: 'review-submit' });
    const r = renderCreateReview(c.src, c.data ?? { fund: { name: 'F' } }, c.base);
    return { rendered: r.renderedHtml };
  } catch (e) {
    return { rejected: (e as { message?: string }).message ?? String(e) };
  }
}

/** 承認画面の文字(DOM の body の文字。コメントは数えない)。 */
function approvalText(html: string): string {
  return parseHTML(html).document.body?.textContent ?? '';
}

describe('敵対レビューの全形', () => {
  it('表は 89 形で、本番で印が見える形を含む', () => {
    expect(CASES).toHaveLength(89);
    expect(CASES.filter((c) => c.prodShows).length).toBeGreaterThan(50);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s: 表の gatePass は今の照合と同じ', (_id, c) => {
    let pass = true;
    try {
      assertTemplateScriptsUnchanged(c.base, c.src, { templateId: 't', where: 'review-submit' });
    } catch {
      pass = false;
    }
    expect(pass).toBe(c.gatePass);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s: 受付で止まるか、承認画面に出る', (_id, c) => {
    const r = submit(c);
    if ('rejected' in r) return;
    if (c.prodShows) expect(approvalText(r.rendered), c.src).toContain(c.mark);
  });

  it.each(CASES.filter((c) => c.id.startsWith('c6head/')).map((c) => [c.id, c] as const))(
    '%s: head の差し替えは受付で止まる',
    (_id, c) => {
      expect(submit(c)).toHaveProperty('rejected');
    },
  );

  it('先頭の BOM は 1 文字だけ外して検査・描画する(基準の BOM も同じ)', () => {
    const doc = '<html><head><title>t</title></head><body><p>{{ fund.name }}</p></body></html>';
    const r = renderCreateReview(`\uFEFF${doc}`, { fund: { name: 'F' } }, `\uFEFF${doc}`);
    expect(r.renderedHtml.startsWith('<html>')).toBe(true);
    expect(() => renderCreateReview(`\uFEFF\uFEFF${doc}`, {}, doc)).toThrow(/骨格/);
  });

  it('基準のままの文書は通る(表の基準の自己一致)', () => {
    for (const base of new Set(CASES.map((c) => c.base))) {
      const r = submit({ id: 'base', src: base, base, mark: '', gatePass: true, prodShows: false });
      expect(r, base).toHaveProperty('rendered');
    }
  });

  it('meta の charset の差し替えは止める(本番だけ別の文字コードで読まれる)', () => {
    // 基準の charset を iso-2022-jp に変え、エスケープ列でコメントを開く(rv3 の charset.mjs)。
    const base =
      '<html><head><meta charset="utf-8"><title>t</title></head><body>' +
      '<section data-part-id="s">本文 {{ fund.name }}</section></body></html>';
    const src = base
      .replace('utf-8', 'iso-2022-jp')
      .replace('本文 {{ fund.name }}', '本文 {{ fund.name }}\x1b$B<!--\x1b(B<p>本番だけ</p>-->');
    expect(
      submit({ id: 'charset', src, base, mark: '本番だけ', gatePass: true, prodShows: true }),
    ).toHaveProperty('rejected');
    // charset を変えなくても、制御文字(ESC)だけで止める。
    const esc = base.replace('本文', '本文\x1b$B');
    expect(
      submit({ id: 'esc', src: esc, base, mark: '', gatePass: true, prodShows: false }),
    ).toHaveProperty('rejected');
  });
});

describe('fixture のテンプレート 8 本は、自分自身を基準にして受付の全体を通る', () => {
  const root = path.resolve(__dirname, '../../fixtures');
  const files = fs.readdirSync(path.join(root, 'templates')).filter((f) => f.endsWith('.html'));
  it.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(root, 'templates', file), 'utf8');
    const fund = file.split('_')[1] ?? '';
    const sample = JSON.parse(
      fs.readFileSync(path.join(root, 'sample', `${fund}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const r = submit({
      id: file,
      src,
      base: src,
      mark: '',
      gatePass: true,
      prodShows: false,
      data: sample,
    });
    expect(r, file).toHaveProperty('rendered');
  });
});
