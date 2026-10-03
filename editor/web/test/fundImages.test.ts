// =============================================================================
// fundImages.test.ts — 編集画面でファンド別画像を差す対象と CSS の固定
// =============================================================================
// 差す範囲は PDF・プレビューと同じにする(編集画面だけ見えるずれを作らない)。Jinja 本文は
// `{{ fund.code }}` をテンプレ ID のファンドコードで解き、値入り本文は確定パスだけを差す。
import { buildSampleData, parseTemplateFileName } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  cssString,
  FUND_IMAGE_WARNING_MESSAGE,
  fundCodeOfTemplateId,
  fundImageCss,
  needsFundImageWarning,
  resolveFundImageSrc,
} from '@/features/editor/fundImages';

const ID = 'AM01_510037_20250105_交付版';
const JINJA = { mode: 'jinja' as const, fundCode: '510037' };
const FILLED = { mode: 'filled' as const, fundCode: '510037' };

describe('fundCodeOfTemplateId', () => {
  it('テンプレ ID からファンドコードを取り出す(不正な ID は null)', () => {
    expect(fundCodeOfTemplateId(ID)).toBe('510037');
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
    'images/{{ fund.code }}_logo.svg',
    'images/{{fund.code}}_logo.svg',
    'images/{{   fund.code   }}_logo.svg',
    'images/510037_logo.svg',
  ])('Jinja 本文: %s は 510037_logo.svg を差す', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toBe('510037_logo.svg');
  });

  it('Jinja 本文でもファンドコードが分からなければ解かない', () => {
    expect(
      resolveFundImageSrc('images/{{ fund.code }}_logo.svg', { ...JINJA, fundCode: null }),
    ).toBeNull();
  });

  it('置換記法になる `$` をファンドコードが含んでも字面のまま差し込む', () => {
    expect(
      resolveFundImageSrc('images/{{ fund.code }}.svg', { mode: 'jinja', fundCode: 'a$&b' }),
    ).toBe('a$&b.svg');
  });

  it('値入り本文は確定パスだけを差し、{{ … }} の残る参照は解かない', () => {
    expect(resolveFundImageSrc('images/510037_logo.svg', FILLED)).toBe('510037_logo.svg');
    expect(resolveFundImageSrc('images/{{ fund.code }}_logo.svg', FILLED)).toBeNull();
  });

  it.each([
    'images/{{ report.x }}_logo.svg',
    'images/{% if a %}x{% endif %}.svg',
    'photos/510037_logo.svg',
    '/images/510037_logo.svg',
    'images/sub/510037_logo.svg',
    'images/510037_anim.gif',
    'images/../css/x.svg',
    'https://evil.example/images/510037_logo.svg',
  ])('%s は対象外', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toBeNull();
    expect(resolveFundImageSrc(src, FILLED)).toBeNull();
  });
});

describe('needsFundImageWarning', () => {
  it('値入り本文に {{ の残る images/ 参照があるときだけ真', () => {
    expect(needsFundImageWarning(['images/{{ fund.code }}_logo.svg'], FILLED)).toBe(true);
    expect(needsFundImageWarning(['images/{{ fund.code }}_logo.svg'], JINJA)).toBe(false);
    expect(needsFundImageWarning(['images/510037_logo.svg', 'photos/{{ x }}.png'], FILLED)).toBe(
      false,
    );
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

  it('原文の src の字面でセレクタを書き、配信 URL を content に置く', () => {
    const { css, urls } = fundImageCss(
      [
        'images/{{ fund.code }}_logo.svg',
        'images/510037_logo.svg',
        'images/{{ fund.code }}_logo.svg',
        'photos/x.png',
      ],
      JINJA,
    );
    expect(css).toBe(
      'img[src="images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}\n' +
        'img[src="images/510037_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}',
    );
    expect(urls).toEqual(['/api/fund-assets/images/510037_logo.svg']);
  });

  it('src に引用符・括弧・山括弧・改行が入っても 1 規則のまま閉じない', () => {
    const src = 'images/510037_a"b]<c>\nd.svg';
    const { css } = fundImageCss([src], JINJA);
    expect(css.split('\n')).toHaveLength(1);
    expect(
      css.startsWith('img[src="images/510037_a\\"b]\\3c c\\3e \\a d.svg"]{content:url("/api/'),
    ).toBe(true);
    expect(css).not.toContain('<');
  });

  it('対象が無ければ空', () => {
    expect(fundImageCss(['photos/x.png'], FILLED)).toEqual({ css: '', urls: [] });
  });
});

describe('fundCodeOfTemplateId', () => {
  it('fundCodeOfTemplateId はテンプレート(3 つ区切り)の id からもファンドコードを取る', () => {
    expect(fundCodeOfTemplateId('AM01_510037_交付版')).toBe('510037');
    expect(fundCodeOfTemplateId('AM01_510037_20240710_交付版')).toBe('510037');
    expect(fundCodeOfTemplateId('規約外')).toBeNull();
  });
});
