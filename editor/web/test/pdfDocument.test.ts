import { isErr, isOk } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { PDF_ERROR_MSG, renderPdfDocument } from '@/lib/pdfDocument';

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
});
