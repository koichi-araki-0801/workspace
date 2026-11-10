import { isOk } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { renderReportDocument } from '@/lib/pdfDocument';

const ID = 'XX01_950037_20240710_交付版';
const LINK = '../css/XX01_950037_交付版.css';

async function render(html: string, company: string | null = 'XX01'): Promise<string> {
  const res = await renderReportDocument(ID, html, company);
  if (!isOk(res)) {
    throw new Error('render failed');
  }
  return res.value;
}

const linkCount = (doc: string): number =>
  new DOMParser()
    .parseFromString(doc, 'text/html')
    .querySelectorAll(`link[rel="stylesheet"][href="${LINK}"]`).length;

describe('renderReportDocument', () => {
  it('keeps script tags and emits exactly one ../css/<会社_ファンド_版種>.css link even for body-only input', async () => {
    const doc = await render('<p>本文</p><script>fit()</script>');
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('fit()');
    expect(doc).toContain('<head>');
    expect(doc).toContain('<body>');
    expect(linkCount(doc)).toBe(1);
  });

  it('入力に同じ href の link があっても重ねない', async () => {
    const doc = await render(
      `<html><head><link rel="stylesheet" href="${LINK}"></head><body><p>x</p></body></html>`,
    );
    expect(linkCount(doc)).toBe(1);
  });

  it('adds no crop marks css', async () => {
    const doc = await render('<p>x</p>');
    expect(doc).not.toContain(CROP_MARKS_CSS.trim().slice(0, 30));
    expect(doc).not.toContain('<style');
  });

  it('他社の会社フォルダの画像参照を落とす', async () => {
    const doc = await render('<img src="../images/other/a.svg"><img src="../images/xx01/b.svg">');
    expect(doc).not.toContain('images/other/a.svg');
    expect(doc).toContain('images/xx01/b.svg');
  });

  it('不正な ID はエラーにする', async () => {
    const res = await renderReportDocument('bad', '<p>x</p>', null);
    expect(isOk(res)).toBe(false);
  });
});
