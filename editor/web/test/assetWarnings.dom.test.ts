// =============================================================================
// assetWarnings.dom.test.ts — CSS の不在と配信されない画像参照の警告文
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  cssImageIssues,
  cssMissingMessage,
  docImageIssues,
  editorAssetWarnings,
  FUND_IMAGE_WARNING_MESSAGE,
  imageIssueMessages,
  imageRefIssue,
  previewAssetWarnings,
} from '@/lib/assetWarnings';

describe('imageRefIssue', () => {
  it.each([
    ['../images/510037_logo.svg', null],
    ['../images/smtam/qr.svg', null],
    ['data:image/png;base64,AA', null],
    ['https://example.com/x.png', null],
    ['', null],
    ['#x', null],
    ['../images/{{ fund.code }}_logo.svg', 'jinja'],
    ['images/510037_logo.svg', 'unserved'],
    ['../../images/x.svg', 'unserved'],
    ['../images/a/b/x.svg', 'unserved'],
    ['../images/x.gif', 'unserved'],
    ['../photos/x.png', 'unserved'],
    ['../images/other/qr.svg', 'company'],
    ['..\\images\\x.svg', 'unserved'],
    ['/images/x.svg', 'unserved'],
  ])('%s → %s', (url, kind) => {
    expect(imageRefIssue(url, 'doc', 'SMTAM')).toBe(kind);
  });
});

describe('cssImageIssues', () => {
  it('CSS の url() のうち images/ を指すものだけを見る(フォントは見ない)', () => {
    const css =
      '@font-face{src:url(fonts/x.woff2)}.a{background:url(../images/a/b/c.svg)}' +
      '.b{background:url(../images/other/d.svg)}.c{background:url(../images/e.svg)}';
    expect(cssImageIssues(css, 'css/template.css', 'SMTAM')).toEqual([
      ['../images/a/b/c.svg', 'unserved'],
      ['../images/other/d.svg', 'company'],
    ]);
  });
});

describe('docImageIssues', () => {
  it('文書の <img> と <style> の画像参照を拾う', () => {
    const html =
      '<html><head><style>.a{background:url(../images/x/y/z.svg)}</style></head>' +
      '<body><img src="images/old.svg"><img src="../images/ok.svg"></body></html>';
    expect(docImageIssues(html, 'SMTAM')).toEqual([
      ['images/old.svg', 'unserved'],
      ['../images/x/y/z.svg', 'unserved'],
    ]);
    expect(docImageIssues('', 'SMTAM')).toEqual([]);
  });

  it('style 属性の url() と、srcset・<source srcset>・<input src>・<video poster> の画像参照も拾う', () => {
    const html =
      '<html><body><div style="background:url(../images/other/s.svg)">a</div>' +
      '<div style="background:url(../images/smtam/ok.svg)">b</div>' +
      '<img src="../images/smtam/a.svg" srcset="../images/smtam/a.svg 1x, ../images/other/a2.svg 2x">' +
      '<picture><source srcset="../images/x/y/p.svg"></picture>' +
      '<input type="image" src="../images/other/i.svg">' +
      '<video poster="../images/other/v.svg"></video>' +
      '<a href="https://example.com/">x</a></body></html>';
    expect(docImageIssues(html, 'SMTAM')).toEqual([
      ['../images/other/s.svg', 'company'],
      ['../images/other/a2.svg', 'company'],
      ['../images/x/y/p.svg', 'unserved'],
      ['../images/other/i.svg', 'company'],
      ['../images/other/v.svg', 'company'],
    ]);
  });
});

describe('imageIssueMessages', () => {
  it('種類ごとに 1 文にまとめ、参照は 3 件まで並べて残りは件数で出す', () => {
    const out = imageIssueMessages(
      [
        ['a.svg', 'unserved'],
        ['b.svg', 'unserved'],
        ['c.svg', 'unserved'],
        ['d.svg', 'unserved'],
        ['a.svg', 'unserved'],
        ['../images/other/q.svg', 'company'],
        ['../images/{{ fund.code }}.svg', 'jinja'],
      ],
      'SMTAM',
    );
    expect(out).toEqual([
      FUND_IMAGE_WARNING_MESSAGE,
      '配信されない画像参照があります（a.svg、b.svg、c.svg ほか1件）。' +
        '画像は ../images/<名前> か ../images/<会社フォルダ>/<名前> で参照してください',
      '会社フォルダ名がテンプレの会社コード（SMTAM）と違うため表示しません（../images/other/q.svg）',
    ]);
    expect(imageIssueMessages([], 'SMTAM')).toEqual([]);
  });
});

describe('cssMissingMessage / editorAssetWarnings / previewAssetWarnings', () => {
  const ID = 'SMTAM_110024_2024-05-17_交付版';

  it('CSS の名前は文書 ID から導いた名前で出す', () => {
    expect(cssMissingMessage(ID)).toBe(
      'CSS SMTAM_110024_交付版.css が見つかりません。スタイルを当てずに表示しています',
    );
  });

  it('編集画面: CSS の不在を先頭に、画像の警告を続ける', () => {
    expect(editorAssetWarnings(ID, true, ['x'])).toEqual([cssMissingMessage(ID), 'x']);
    expect(editorAssetWarnings(ID, false, [])).toEqual([]);
  });

  it('プレビュー: 文書の画像参照を会社コードで照合する', () => {
    const doc = '<img src="../images/smtam/qr.svg"><img src="../images/am01/qr.svg">';
    expect(previewAssetWarnings(ID, false, doc)).toEqual([
      '会社フォルダ名がテンプレの会社コード（SMTAM）と違うため表示しません（../images/am01/qr.svg）',
    ]);
    expect(previewAssetWarnings(ID, true, '')).toEqual([cssMissingMessage(ID)]);
  });

  it('配信されない参照(ルート外・2 段以上・バックスラッシュ・会社フォルダ違い)は黙って消えず警告に出る', () => {
    const doc =
      '<img src="../../images/out.svg"><img src="../images/a/b/deep.svg">' +
      '<img src="..\\images\\back.svg"><img src="../images/am01/qr.svg">';
    const out = previewAssetWarnings(ID, false, doc);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('配信されない画像参照があります');
    for (const r of ['../../images/out.svg', '../images/a/b/deep.svg', '..\\images\\back.svg']) {
      expect(out[0]).toContain(r);
    }
    expect(out[1]).toContain('../images/am01/qr.svg');
  });
});
