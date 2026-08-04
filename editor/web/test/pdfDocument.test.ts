import { isErr, isOk } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { PDF_CSS_EXTERNAL_REF_MSG, PDF_ERROR_MSG, renderPdfDocument } from '@/lib/pdfDocument';

describe('renderPdfDocument', () => {
  it('renders Jinja values and sanitizes active content', async () => {
    const res = await renderPdfDocument('<p>{{ name }}</p><script>alert(1)</scr' + 'ipt>', '.c{}', {
      name: 'ファンドA',
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.html).toContain('ファンドA');
      expect(res.value.html).not.toContain('<script');
      expect(res.value.css).toBe('.c{}');
    }
  });

  it('appends trim-mark CSS only when cropMarks is on', async () => {
    const on = await renderPdfDocument('<p>x</p>', '.c{}', {}, { cropMarks: true });
    const off = await renderPdfDocument('<p>x</p>', '.c{}', {}, { cropMarks: false });
    expect(isOk(on) && on.value.css.includes(CROP_MARKS_CSS)).toBe(true);
    expect(isOk(off) && !off.value.css.includes(CROP_MARKS_CSS)).toBe(true);
  });

  it('returns err with the safe message when the template fails to render', async () => {
    const res = await renderPdfDocument('<p>{{ oops</p>', '', {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(PDF_ERROR_MSG);
  });

  // PDF は CSP の無い headless ブラウザで組版されるため、CSS からの外向き通信は
  // 「削る」ではなく「拒む」(削る実装は CSS のエスケープで必ず迂回される)。
  it.each([
    ['@import url(http://evil.example/x.css);', '素の @import'],
    ['@\\69 mport url(http://evil.example/x.css);', 'エスケープ難読化した @import'],
    ['.a{background:url(\\68ttp://evil.example/y.png)}', 'エスケープ難読化した絶対 URL'],
    ['.a{background:url(//evil.example/y.png)}', 'scheme 相対 URL'],
    ['@font-face{src:url("https://evil.example/f.woff2")}', '外部フォント'],
  ])('外部参照を含む CSS(%s = %s)で PDF を作らない', async (css) => {
    const res = await renderPdfDocument('<p>x</p>', css, {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(PDF_CSS_EXTERNAL_REF_MSG);
  });

  it('自己完結な CSS(相対パス / data:image / 文字列中の字面)は通す', async () => {
    const css =
      '.a{background:url(img/a.png)}' +
      '.b{background:url("data:image/png;base64,AAAA")}' +
      '.c::after{content:"@import url(http://evil.example/x)"}' +
      '/* @import url(http://evil.example/y) */' +
      '@media print{.d{color:red}}';
    const res = await renderPdfDocument('<p>x</p>', css, {});
    expect(isOk(res)).toBe(true);
  });
});
