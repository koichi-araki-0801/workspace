// =============================================================================
// canvasCssAssets.test.ts — 編集画面の canvas 専用に、url() を含む規則を配信 URL へ直した複製
// =============================================================================
import { DOC_DIR } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  canvasAssetUrl,
  canvasCssAssetCopy,
  canvasCssFullCopy,
} from '@/features/editor/canvasCssAssets';

describe('canvasAssetUrl', () => {
  it('フォントはプレビューホスト、画像は fund-assets の配信 URL にする', () => {
    expect(canvasAssetUrl('css/fonts/BIZ UD.woff2', null)).toBe(
      '/api/preview-host/css/fonts/BIZ%20UD.woff2',
    );
    expect(canvasAssetUrl('images/510037_bg.svg', null)).toBe(
      '/api/fund-assets/images/510037_bg.svg',
    );
    expect(canvasAssetUrl('images/am01/qr.svg', 'AM01')).toBe(
      '/api/fund-assets/images/am01/qr.svg',
    );
  });

  it.each([
    ['images/smtam/qr.svg', 'AM01'],
    ['images/a/b/c.svg', 'AM01'],
    ['images/x.gif', 'AM01'],
    ['css/other.css', 'AM01'],
    ['js/x.js', 'AM01'],
  ])('%s(会社 %s)は配らない', (rel, company) => {
    expect(canvasAssetUrl(rel, company)).toBeUndefined();
  });
});

describe('canvasCssAssetCopy', () => {
  it('url() を含む規則だけを、配信 URL へ直して複製する', () => {
    const css =
      '@font-face{font-family:biz;src:url(fonts/biz.woff2) format("woff2")}' +
      '.page{color:red}' +
      '.logo{background:url(../images/510037_bg.svg) no-repeat}';
    const out = canvasCssAssetCopy(css, 'AM01');
    expect(out).toContain(
      '@font-face{font-family:biz;src:url("/api/preview-host/css/fonts/biz.woff2") format("woff2")}',
    );
    expect(out).toContain(
      '.logo{background:url("/api/fund-assets/images/510037_bg.svg") no-repeat}',
    );
    expect(out).not.toContain('color:red');
  });

  it('at-rule の中の規則は前置きで包み直す', () => {
    const out = canvasCssAssetCopy('@media print{.a{background:url(../images/a.svg)}}', null);
    expect(out).toBe('@media print{.a{background:url("/api/fund-assets/images/a.svg")}}');
  });

  it('配らない参照だけの規則・data: やルート外の参照は複製しない', () => {
    const css =
      '.x{background:url(../images/smtam/q.svg)}' +
      '.y{background:url(data:image/png;base64,AA)}' +
      '.z{background:url(../../x.png)}';
    expect(canvasCssAssetCopy(css, 'AM01')).toBe('');
  });

  it('url() を持たない宣言は複製に入れない(後ろの規則との優先順位を canvas で変えない)', () => {
    const out = canvasCssAssetCopy(
      '.a{background:url(../images/a.svg);color:blue}.b{color:red}',
      null,
    );
    expect(out).toBe('.a{background:url("/api/fund-assets/images/a.svg")}');
    expect(out).not.toContain('color');
  });

  it('url() の一括指定より後ろにある同じ系統の個別指定は残す(一括指定の初期化で消さない)', () => {
    const out = canvasCssAssetCopy(
      '.a{background:url(../images/a.svg) center;color:blue;background-size:cover;' +
        'background-color:#eee}',
      null,
    );
    expect(out).toBe(
      '.a{background:url("/api/fund-assets/images/a.svg") center;background-size:cover;' +
        'background-color:#eee}',
    );
  });

  it('一括指定より前の個別指定は元の規則でも初期化されているので複製しない', () => {
    const out = canvasCssAssetCopy(
      '.a{background-color:#eee;background:url(../images/a.svg)}',
      null,
    );
    expect(out).toBe('.a{background:url("/api/fund-assets/images/a.svg")}');
  });

  it('個別指定の url() は他の宣言を引き込まない', () => {
    const out = canvasCssAssetCopy(
      '.a{background-image:url(../images/a.svg);background-size:cover;color:red}',
      null,
    );
    expect(out).toBe('.a{background-image:url("/api/fund-assets/images/a.svg")}');
  });

  it('at-rule の中でも一括指定の後ろの個別指定を残して包み直す', () => {
    const out = canvasCssAssetCopy(
      '@media print{.a{margin:0;background:url(../images/a.svg);/* x */background-repeat:no-repeat}}',
      null,
    );
    expect(out).toBe(
      '@media print{.a{background:url("/api/fund-assets/images/a.svg");background-repeat:no-repeat}}',
    );
  });

  it('at-rule の中の規則も url() の宣言だけを残し、前置きで包み直す', () => {
    const out = canvasCssAssetCopy(
      '@media print{.a{color:blue;background:url(../images/a.svg) no-repeat;margin:0}}',
      null,
    );
    expect(out).toBe('@media print{.a{background:url("/api/fund-assets/images/a.svg") no-repeat}}');
  });

  it('@font-face は記述子をすべて残して丸ごと複製する', () => {
    const out = canvasCssAssetCopy(
      '/* 本文 */@font-face{font-family:"biz";font-weight:700;font-style:normal;' +
        'src:url(fonts/biz.woff2) format("woff2")}',
      null,
    );
    expect(out).toContain(
      '@font-face{font-family:"biz";font-weight:700;font-style:normal;' +
        'src:url("/api/preview-host/css/fonts/biz.woff2") format("woff2")}',
    );
  });

  it('宣言の区切りは文字列・括弧・コメントの中の ; と } を数えない', () => {
    const out = canvasCssAssetCopy(
      '.a{content:"x;}";background:url("../images/a.svg");/* ; */color:red}',
      null,
    );
    expect(out).toBe('.a{background:url("/api/fund-assets/images/a.svg")}');
  });

  it('url() の無い CSS は空', () => {
    expect(canvasCssAssetCopy('.a{color:red}', null)).toBe('');
    expect(canvasCssAssetCopy('', null)).toBe('');
  });

  it('日本語のファイル名は区切りごとに 1 回だけ percent-encode する(既に %XX でも二重にしない)', () => {
    const font = '/api/preview-host/css/fonts/%E6%98%8E%E6%9C%9D.woff2';
    const img = '/api/fund-assets/images/am01/%E8%83%8C%E6%99%AF.svg';
    const raw =
      '@font-face{font-family:m;src:url(fonts/明朝.woff2)}' +
      '.a{background:url("../images/AM01/背景.svg")}';
    const raw2 = canvasCssAssetCopy(raw, 'AM01');
    expect(raw2).toContain(`url("${font}")`);
    expect(raw2).toContain('url("/api/fund-assets/images/AM01/%E8%83%8C%E6%99%AF.svg")');
    const escaped =
      '@font-face{font-family:m;src:url(fonts/%E6%98%8E%E6%9C%9D.woff2)}' +
      '.a{background:url(../images/am01/%E8%83%8C%E6%99%AF.svg)}';
    const out = canvasCssAssetCopy(escaped, 'AM01');
    expect(out).toContain(`url("${font}")`);
    expect(out).toContain(`url("${img}")`);
    expect(out).not.toContain('%25');
  });

  it('先頭に BOM があり改行が CRLF の CSS でも、最初の url() 規則を複製する', () => {
    const css =
      '﻿@font-face {\r\n  font-family: biz;\r\n  src: url(fonts/biz.woff2);\r\n}\r\n' +
      '.p {\r\n  color: red;\r\n}\r\n' +
      '.logo {\r\n  background: url(../images/510037_bg.svg);\r\n}\r\n';
    const out = canvasCssAssetCopy(css, null);
    expect(out).toContain('url("/api/preview-host/css/fonts/biz.woff2")');
    expect(out).toContain('url("/api/fund-assets/images/510037_bg.svg")');
    expect(out).not.toContain('color: red');
    expect(out.startsWith('@font-face')).toBe(true);
    expect(out.match(/url\(/g)).toHaveLength(2);
  });

  it('参照元に文書の位置を渡すと、本文の <style> の url() を文書基準で解く', () => {
    const css = '@font-face{font-family:F;src:url(../css/fonts/f.woff2)}';
    expect(canvasCssAssetCopy(css, 'AM01', DOC_DIR)).toBe(
      '@font-face{font-family:F;src:url("/api/preview-host/css/fonts/f.woff2")}',
    );
    // 参照元を省くと今どおり CSS の位置(`css/`)で解く。
    expect(canvasCssAssetCopy('@font-face{font-family:F;src:url(fonts/f.woff2)}', 'AM01')).toBe(
      '@font-face{font-family:F;src:url("/api/preview-host/css/fonts/f.woff2")}',
    );
    // 同じ `url(fonts/…)` でも、文書の位置からは `doc/fonts/…` を指すので配らない。
    expect(
      canvasCssAssetCopy('@font-face{font-family:F;src:url(fonts/f.woff2)}', 'AM01', DOC_DIR),
    ).toBe('');
  });

  it('文書基準の画像も会社フォルダの照合を通る', () => {
    expect(canvasCssAssetCopy('.a{background:url(../images/AM01/x.svg)}', 'AM01', DOC_DIR)).toBe(
      '.a{background:url("/api/fund-assets/images/AM01/x.svg")}',
    );
    expect(canvasCssAssetCopy('.a{background:url(../images/SMTAM/x.svg)}', 'AM01', DOC_DIR)).toBe(
      '',
    );
  });
});

describe('canvasCssFullCopy(本文の <style> の全規則)', () => {
  it('url() の無い規則も囲む at-rule ごと複製する', () => {
    expect(canvasCssFullCopy('.a{color:red}\n@media print{.b{margin:0}}', 'AM01')).toBe(
      '.a{color:red}\n@media print{.b{margin:0}}',
    );
  });

  it('url() は文書の位置を基準に配信 URL へ直し、他の宣言も残す', () => {
    expect(
      canvasCssFullCopy('.p{color:red;background:url(../images/AM01/x.svg) no-repeat}', 'AM01'),
    ).toBe('.p{color:red;background:url("/api/fund-assets/images/AM01/x.svg") no-repeat}');
    expect(
      canvasCssFullCopy('@font-face{font-family:F;src:url(../css/fonts/f.woff2)}', 'AM01'),
    ).toBe('@font-face{font-family:F;src:url("/api/preview-host/css/fonts/f.woff2")}');
  });

  it('直せない url() の宣言だけを落とし、@font-face は規則ごと落とす', () => {
    expect(canvasCssFullCopy('.p{color:red;background:url(x.png)}', 'AM01')).toBe('.p{color:red}');
    expect(canvasCssFullCopy('.p{background:url(../images/SMTAM/x.svg);margin:0}', 'AM01')).toBe(
      '.p{margin:0}',
    );
    expect(canvasCssFullCopy('@font-face{font-family:F;src:url(f.woff2)}.a{color:red}', null)).toBe(
      '.a{color:red}',
    );
  });

  it('宣言を落として空になった規則は出さない', () => {
    expect(canvasCssFullCopy('.p{background:url(x.png)}.a{color:red}', null)).toBe('.a{color:red}');
    expect(canvasCssFullCopy('@media print{.p{background:url(x.png);}}', null)).toBe('');
  });

  it('文書の中の参照(許可した data: URI・断片)はそのまま残す', () => {
    const css = '.p{background:url(data:image/png;base64,AAAA)}.q{filter:url(#f)}';
    expect(canvasCssFullCopy(css, null)).toBe(
      '.p{background:url(data:image/png;base64,AAAA)}\n.q{filter:url(#f)}',
    );
  });

  it('文書の外を取りに行く参照が残る規則は複製しない', () => {
    expect(canvasCssFullCopy('@import url(http://e.example/x.css);.a{color:red}', null)).toBe(
      '.a{color:red}',
    );
    expect(
      canvasCssFullCopy(
        '.p{background:image-set("https://e.example/x.png" 1x)}.a{color:red}',
        null,
      ),
    ).toBe('.a{color:red}');
    expect(canvasCssFullCopy('.p{background:url(https://e.example/x.png);color:red}', null)).toBe(
      '.p{color:red}',
    );
  });
});
