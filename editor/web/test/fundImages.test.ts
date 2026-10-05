// =============================================================================
// fundImages.test.ts — 編集画面でファンド別画像を差す対象と CSS の固定
// =============================================================================
// 差す範囲は PDF・プレビューと同じにする(編集画面だけ見えるずれを作らない)。Jinja 本文は
// `{{ fund.code }}` をテンプレ ID のファンドコードで解き、値入り本文は確定パスだけを差す。
// 参照は文書位置基準(`../images/…`)で、会社フォルダは会社コードと照合する。
import { buildSampleData, parseTemplateFileName } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  cssString,
  fundCodeOfTemplateId,
  fundImageCss,
  fundImageWarnings,
  resolveFundImageSrc,
} from '@/features/editor/fundImages';
import { FUND_IMAGE_WARNING_MESSAGE } from '@/lib/assetWarnings';

const ID = 'AM01_510037_20250105_交付版';
const JINJA = { mode: 'jinja' as const, fundCode: '510037', companyCode: 'AM01' };
const FILLED = { mode: 'filled' as const, fundCode: '510037', companyCode: 'AM01' };
const LOGO = { dir: null, file: '510037_logo.svg' };

describe('fundCodeOfTemplateId', () => {
  it('テンプレ ID からファンドコードを取り出す(不正な ID は null)', () => {
    expect(fundCodeOfTemplateId(ID)).toBe('510037');
    expect(fundCodeOfTemplateId('AM01_510037_交付版')).toBe('510037');
    expect(fundCodeOfTemplateId('not-a-template')).toBeNull();
  });

  it('buildSampleData が fund.code に入れる値と出所が一致する', () => {
    const attrs = parseTemplateFileName(`${ID}.html`);
    expect(attrs).not.toBeNull();
    const fund = buildSampleData(undefined, attrs?.fundCode ?? '').fund as { code: string };
    expect(fundCodeOfTemplateId(ID)).toBe(fund.code);
  });
});

describe('resolveFundImageSrc', () => {
  it.each([
    '../images/{{ fund.code }}_logo.svg',
    '../images/{{fund.code}}_logo.svg',
    '../images/{{   fund.code   }}_logo.svg',
    '../images/510037_logo.svg',
  ])('Jinja 本文: %s は images/510037_logo.svg を差す', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toEqual(LOGO);
  });

  it('Jinja 本文でもファンドコードが分からなければ解かない', () => {
    expect(
      resolveFundImageSrc('../images/{{ fund.code }}_logo.svg', { ...JINJA, fundCode: null }),
    ).toBeNull();
  });

  it('置換記法になる `$` をファンドコードが含んでも字面のまま差し込む', () => {
    expect(
      resolveFundImageSrc('../images/{{ fund.code }}.svg', { ...JINJA, fundCode: 'a$&b' }),
    ).toEqual({ dir: null, file: 'a$&b.svg' });
  });

  it('値入り本文は確定パスだけを差し、{{ … }} の残る参照は解かない', () => {
    expect(resolveFundImageSrc('../images/510037_logo.svg', FILLED)).toEqual(LOGO);
    expect(resolveFundImageSrc('../images/{{ fund.code }}_logo.svg', FILLED)).toBeNull();
  });

  it('会社フォルダは会社コードと大文字小文字の違いだけで一致するときに差す', () => {
    expect(resolveFundImageSrc('../images/am01/qr_code.svg', FILLED)).toEqual({
      dir: 'am01',
      file: 'qr_code.svg',
    });
    expect(resolveFundImageSrc('../images/smtam/qr_code.svg', FILLED)).toBeNull();
    expect(
      resolveFundImageSrc('../images/am01/qr_code.svg', { ...FILLED, companyCode: null }),
    ).toBeNull();
  });

  it.each([
    '../images/{{ report.x }}_logo.svg',
    '../images/{% if a %}x{% endif %}.svg',
    '../photos/510037_logo.svg',
    'images/510037_logo.svg',
    '/images/510037_logo.svg',
    '../../images/510037_logo.svg',
    '../images/a/b/510037_logo.svg',
    '../images/510037_anim.gif',
    '../images/../css/x.svg',
    'https://evil.example/images/510037_logo.svg',
  ])('%s は対象外', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toBeNull();
    expect(resolveFundImageSrc(src, FILLED)).toBeNull();
  });
});

describe('fundImageWarnings', () => {
  it('値入り本文: {{ の残る images/ 参照・配信されない参照・会社フォルダ不一致をまとめる', () => {
    expect(
      fundImageWarnings(
        [
          '../images/{{ fund.code }}_logo.svg',
          'images/510037_logo.svg',
          '../images/smtam/qr.svg',
          '../images/510037_logo.svg',
        ],
        FILLED,
      ),
    ).toEqual([
      FUND_IMAGE_WARNING_MESSAGE,
      '配信されない画像参照があります（images/510037_logo.svg）。' +
        '画像は ../images/<名前> か ../images/<会社フォルダ>/<名前> で参照してください',
      '会社フォルダ名がテンプレの会社コード（AM01）と違うため表示しません（../images/smtam/qr.svg）',
    ]);
  });

  it('Jinja 本文: {{ fund.code }} を解いてから判定し、解けない式の残る参照は見ない', () => {
    expect(
      fundImageWarnings(
        ['../images/{{ fund.code }}_logo.svg', '../images/{{ report.x }}.svg'],
        JINJA,
      ),
    ).toEqual([]);
    expect(fundImageWarnings(['../images/{{ fund.code }}/a/b.svg'], JINJA)).toHaveLength(1);
  });

  it('CSS 由来の問題も同じ欄にまとめる', () => {
    expect(fundImageWarnings([], FILLED, [['../images/x/y/z.svg', 'unserved']])).toHaveLength(1);
  });

  it('警告文は {{ fund.code }} を字面で含む(Vue の補間に渡さず定数で出す)', () => {
    expect(FUND_IMAGE_WARNING_MESSAGE).toContain('{{ fund.code }}');
  });
});

describe('cssString / fundImageCss', () => {
  it('CSS の文字列として安全に引用する', () => {
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(cssString('a\nb')).toBe('"a\\a b"');
    expect(cssString('</style>')).toBe('"\\3c /style\\3e "');
  });

  it('任意の文字列で文字列リテラルから抜け出せない(引用符・改行・括弧・非 ASCII)', () => {
    expect(cssString('a]b')).toBe('"a]b"');
    expect(cssString('a\r\nb\fc\u007fd')).toBe('"a\\d \\a b\\c c\\7f d"');
    expect(cssString('画像_ロゴ.svg')).toBe('"画像_ロゴ.svg"');
    expect(cssString('"];}body{x:y}/*')).toBe('"\\"];}body{x:y}/*"');
    expect(cssString('')).toBe('""');
  });

  it('原文の src の字面でセレクタを書き、配信 URL を content に置く(会社フォルダを含む)', () => {
    const { css, urls } = fundImageCss(
      [
        '../images/{{ fund.code }}_logo.svg',
        '../images/510037_logo.svg',
        '../images/{{ fund.code }}_logo.svg',
        '../images/AM01/qr.svg',
        '../photos/x.png',
      ],
      JINJA,
    );
    expect(css).toBe(
      'img[src="../images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}\n' +
        'img[src="../images/510037_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}\n' +
        'img[src="../images/AM01/qr.svg"]{content:url("/api/fund-assets/images/AM01/qr.svg")}',
    );
    expect(urls).toEqual([
      '/api/fund-assets/images/510037_logo.svg',
      '/api/fund-assets/images/AM01/qr.svg',
    ]);
  });

  it('src に引用符・括弧・山括弧・改行が入っても 1 規則のまま閉じない', () => {
    const src = '../images/510037_a"b]<c>\nd.svg';
    const { css } = fundImageCss([src], JINJA);
    expect(css.split('\n')).toHaveLength(1);
    expect(
      css.startsWith('img[src="../images/510037_a\\"b]\\3c c\\3e \\a d.svg"]{content:url("/api/'),
    ).toBe(true);
    expect(css).not.toContain('<');
  });

  it('対象が無ければ空', () => {
    expect(fundImageCss(['../photos/x.png'], FILLED)).toEqual({ css: '', urls: [] });
  });
});
