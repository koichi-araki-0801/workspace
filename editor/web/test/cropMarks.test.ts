// =============================================================================
// cropMarks.test.ts — トンボ CSS 注入の回帰
// =============================================================================
// 主張は再パースした DOM に対して行う(文字列の位置比較は攻撃入力で満たせてしまう)。
import { describe, expect, it } from 'vitest';
import { CROP_MARKS_CSS, withCropMarks } from '../src/lib/cropMarks';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function cropStyle(html: string): Element | null {
  return parse(html).querySelector('style[data-crop-marks]');
}

describe('withCropMarks', () => {
  const doc = '<html><head><title>t</title></head><body>x</body></html>';

  it('returns the document unchanged when off', () => {
    expect(withCropMarks(doc, false)).toBe(doc);
  });

  it('injects the trim-mark style into <head> when on', () => {
    const style = cropStyle(withCropMarks(doc, true));
    expect(style?.parentElement?.tagName).toBe('HEAD');
    expect(style?.textContent).toBe(CROP_MARKS_CSS);
  });

  it('normalizes a head-less document and still lands in <head>', () => {
    const out = withCropMarks('<body class="r">x</body>', true);
    const parsed = parse(out);
    expect(parsed.body.getAttribute('class')).toBe('r');
    expect(parsed.querySelector('style[data-crop-marks]')?.parentElement?.tagName).toBe('HEAD');
  });

  it('wraps a bare fragment in a full document', () => {
    const out = withCropMarks('just text', true);
    expect(out).toContain('<!doctype html>');
    expect(cropStyle(out)?.parentElement?.tagName).toBe('HEAD');
    expect(parse(out).body.textContent).toContain('just text');
  });

  it('uses crop + cross marks (corner and center)', () => {
    expect(CROP_MARKS_CSS).toMatch(/marks:\s*crop cross/);
  });

  // 旧実装は `</head>` を文字列で探して割り込んでいた。属性値に字面を置くと、アプリが
  // 組み立てた <style> が属性値の内側へ落ち、続く字面が属性トークン列として再解釈された。
  it('属性値に埋めた </head> の字面で <style> が属性の内側へ落ちない', () => {
    const evil = '<html><head><title data-x="</head>">t</title></head><body>b</body></html>';
    const out = withCropMarks(evil, true);
    const parsed = parse(out);
    expect(parsed.querySelector('style[data-crop-marks]')?.parentElement?.tagName).toBe('HEAD');
    const handlers = Array.from(parsed.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((a) => /^on/i.test(a.name))
        .map((a) => a.name),
    );
    expect(handlers).toEqual([]);
  });

  it('属性値に埋めた <body …> の字面でも本文が失われない', () => {
    const out = withCropMarks('<p title="<body onload=alert(1)>">keep</p>', true);
    const parsed = parse(out);
    expect(parsed.body.textContent).toContain('keep');
    expect(parsed.body.hasAttribute('onload')).toBe(false);
  });
});
