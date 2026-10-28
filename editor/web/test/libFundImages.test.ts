// =============================================================================
// libFundImages.test.ts — ファンド別画像の判定・配信 URL・会社フォルダ照合の固定
// =============================================================================
import { DOC_CSS_PATH } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyImageRel,
  companyCodeOfTemplateId,
  companyFolderMatches,
  dropUnmatchedCompanyImageUrls,
  type FundImageRef,
  fundImageMime,
  fundImageRefOf,
  fundImageUrl,
  servedFundImageOf,
  TEMPLATE_CSS_FROM,
} from '@/lib/fundImages';

describe('TEMPLATE_CSS_FROM', () => {
  it('shared の DOC_CSS_PATH と同じ値(CSS の基準を web で別に持たない)', () => {
    expect(TEMPLATE_CSS_FROM).toBe(DOC_CSS_PATH);
  });
});

describe('fundImageRefOf', () => {
  it('images 直下と 1 段下の許可拡張子だけを ref にする', () => {
    expect(fundImageRefOf('images/950037_logo.svg')).toEqual({
      dir: null,
      file: '950037_logo.svg',
    });
    expect(fundImageRefOf('images/910024_基準価額等の推移.svg')).toEqual({
      dir: null,
      file: '910024_基準価額等の推移.svg',
    });
    expect(fundImageRefOf('images/950037_photo.JPG')).toEqual({
      dir: null,
      file: '950037_photo.JPG',
    });
    expect(fundImageRefOf('images/xxam/qr_code.svg')).toEqual({
      dir: 'xxam',
      file: 'qr_code.svg',
    });
  });

  it.each([
    'images/a/b/x.svg',
    'images/950037_anim.gif',
    'css/950037_logo.svg',
    'images/',
    'images',
    'images//x.svg',
    'images/__proto__',
  ])('%s は対象外', (rel) => {
    expect(fundImageRefOf(rel)).toBeUndefined();
  });
});

describe('fundImageUrl / fundImageMime', () => {
  it('直下は :file、会社フォルダは :dir/:file の経路で、各部分を符号化する', () => {
    expect(fundImageUrl({ dir: null, file: '950037_logo.svg' })).toBe(
      '/api/fund-assets/images/950037_logo.svg',
    );
    expect(fundImageUrl({ dir: null, file: 'a b.svg' })).toBe('/api/fund-assets/images/a%20b.svg');
    expect(fundImageUrl({ dir: 'xxam', file: 'qr_code.svg' })).toBe(
      '/api/fund-assets/images/xxam/qr_code.svg',
    );
    expect(fundImageUrl({ dir: 's m', file: 'a/b.svg' })).toBe(
      '/api/fund-assets/images/s%20m/a%2Fb.svg',
    );
  });

  it('拡張子から MIME を引く(大小文字を問わない)', () => {
    expect(fundImageMime('a.SVG')).toBe('image/svg+xml');
    expect(fundImageMime('a.jpeg')).toBe('image/jpeg');
    expect(fundImageMime('a.gif')).toBeUndefined();
    expect(fundImageMime('noext')).toBeUndefined();
  });
});

describe('companyFolderMatches', () => {
  it('直下の画像は会社コードに関係なく表示してよい', () => {
    expect(companyFolderMatches({ dir: null, file: 'x.svg' }, null)).toBe(true);
    expect(companyFolderMatches({ dir: null, file: 'x.svg' }, 'XXAM')).toBe(true);
  });

  it('会社フォルダは大文字小文字の違いだけを許す', () => {
    expect(companyFolderMatches({ dir: 'xxam', file: 'x.svg' }, 'XXAM')).toBe(true);
    expect(companyFolderMatches({ dir: 'XXAM', file: 'x.svg' }, 'xxam')).toBe(true);
    expect(companyFolderMatches({ dir: 'xxam', file: 'x.svg' }, 'XX01')).toBe(false);
    expect(companyFolderMatches({ dir: 'xxam', file: 'x.svg' }, null)).toBe(false);
  });
});

describe('companyCodeOfTemplateId', () => {
  it('値入り HTML(4 つ区切り)とテンプレ(3 つ区切り)の ID から会社コードを取る', () => {
    expect(companyCodeOfTemplateId('XXAM_910024_2024-05-17_交付版')).toBe('XXAM');
    expect(companyCodeOfTemplateId('XXAM_910024_交付版')).toBe('XXAM');
    expect(companyCodeOfTemplateId('規約外')).toBeNull();
  });
});

describe('servedFundImageOf', () => {
  it('文書からの ../images/… と CSS からの ../images/… を同じ ref に解く', () => {
    expect(servedFundImageOf('../images/950037_logo.svg', 'doc', null)).toEqual({
      dir: null,
      file: '950037_logo.svg',
    });
    expect(servedFundImageOf('../images/950037_logo.svg', TEMPLATE_CSS_FROM, null)).toEqual({
      dir: null,
      file: '950037_logo.svg',
    });
    expect(servedFundImageOf('../images/xxam/qr_code.svg', 'doc', 'XXAM')).toEqual({
      dir: 'xxam',
      file: 'qr_code.svg',
    });
  });

  it.each([
    ['images/950037_logo.svg', 'XXAM'],
    ['../../images/950037_logo.svg', 'XXAM'],
    ['../images/xxam/qr_code.svg', 'XX01'],
    ['../images/a/b/c.svg', 'XXAM'],
    ['https://evil.example/images/x.svg', 'XXAM'],
  ])('%s(会社 %s)は表示しない', (url, company) => {
    expect(servedFundImageOf(url, 'doc', company)).toBeUndefined();
  });
});

describe('dropUnmatchedCompanyImageUrls', () => {
  it('会社フォルダが合わない画像の url() だけを none にする', () => {
    const css =
      '.a{background:url(../images/other/a.svg)}' +
      '.b{background:url(../images/XXAM/b.svg)}' +
      '.c{background:url(../images/c.svg)}' +
      '@font-face{src:url(fonts/x.woff2)}';
    expect(dropUnmatchedCompanyImageUrls(css, TEMPLATE_CSS_FROM, 'xxam')).toBe(
      '.a{background:none}' +
        '.b{background:url(../images/XXAM/b.svg)}' +
        '.c{background:url(../images/c.svg)}' +
        '@font-face{src:url(fonts/x.woff2)}',
    );
  });
});

// サーバは配信ルートの :dir / :file を復号して元の綴りで探す。日本語名は各部分を
// 符号化した URL で取りに行き、HTML に符号化済みで書かれた参照も同じ URL にする(二重符号化しない)。
describe('日本語名の配信 URL', () => {
  const JA = '910024_基準価額等の推移.svg';
  const JA_ENC = encodeURIComponent(JA);

  it('直下・会社フォルダとも部分ごとに符号化する', () => {
    expect(fundImageUrl({ dir: null, file: JA })).toBe(`/api/fund-assets/images/${JA_ENC}`);
    expect(fundImageUrl({ dir: 'xxam', file: 'qr_code.svg' })).toBe(
      '/api/fund-assets/images/xxam/qr_code.svg',
    );
    expect(fundImageUrl({ dir: '会社', file: JA })).toBe(
      `/api/fund-assets/images/${encodeURIComponent('会社')}/${JA_ENC}`,
    );
  });

  it('符号化済みで書かれた参照も生の綴りと同じ ref・同じ URL になる', () => {
    const raw = servedFundImageOf(`../images/${JA}`, 'doc', null);
    const enc = servedFundImageOf(`../images/${JA_ENC}`, 'doc', null);
    expect(raw).toEqual({ dir: null, file: JA });
    expect(enc).toEqual(raw);
    expect(fundImageUrl(enc as FundImageRef)).toBe(`/api/fund-assets/images/${JA_ENC}`);
    expect(fundImageUrl(enc as FundImageRef)).not.toContain('%25');
  });

  it('会社フォルダの日本語名も符号化済みと生の綴りで同じ URL', () => {
    const raw = servedFundImageOf(`../images/xxam/${JA}`, 'doc', 'XXAM');
    const enc = servedFundImageOf(`../images/xxam/${JA_ENC}`, TEMPLATE_CSS_FROM, 'XXAM');
    expect(raw).toEqual({ dir: 'xxam', file: JA });
    expect(enc).toEqual(raw);
    expect(fundImageUrl(raw as FundImageRef)).toBe(`/api/fund-assets/images/xxam/${JA_ENC}`);
  });
});

describe('classifyImageRel', () => {
  it('images/ の外・解けない参照は outside', () => {
    expect(classifyImageRel('css/x.png', 'XX01')).toEqual({ kind: 'outside' });
    expect(classifyImageRel('imagesx/a.png', 'XX01')).toEqual({ kind: 'outside' });
    expect(classifyImageRel(undefined, 'XX01')).toEqual({ kind: 'outside' });
  });

  it('images/ の中でも配信しない形(深さ・拡張子)は other', () => {
    expect(classifyImageRel('images/a/b/c.png', 'XX01')).toEqual({ kind: 'other' });
    expect(classifyImageRel('images/a.gif', 'XX01')).toEqual({ kind: 'other' });
    expect(classifyImageRel('images/', 'XX01')).toEqual({ kind: 'other' });
  });

  it('配信する画像は ref と会社フォルダの一致を返す', () => {
    expect(classifyImageRel('images/a.png', null)).toEqual({
      kind: 'fundImage',
      ref: { dir: null, file: 'a.png' },
      companyMatches: true,
    });
    expect(classifyImageRel('images/xx01/a.png', 'XX01')).toMatchObject({ companyMatches: true });
    expect(classifyImageRel('images/zz/a.png', 'XX01')).toMatchObject({ companyMatches: false });
    expect(classifyImageRel('images/xx01/a.png', null)).toMatchObject({ companyMatches: false });
  });
});
