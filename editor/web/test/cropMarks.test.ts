import { describe, expect, it } from 'vitest';
import { CROP_MARKS_CSS, withCropMarks } from '../src/lib/cropMarks';

describe('withCropMarks', () => {
  const doc = '<html><head><title>t</title></head><body>x</body></html>';

  it('returns the document unchanged when off', () => {
    expect(withCropMarks(doc, false)).toBe(doc);
  });

  it('injects the trim-mark style just before </head> when on', () => {
    const out = withCropMarks(doc, true);
    expect(out).toContain(`<style>${CROP_MARKS_CSS}</style>`);
    expect(out.indexOf(CROP_MARKS_CSS)).toBeLessThan(out.indexOf('</head>'));
  });

  it('falls back to injecting after <body> when there is no </head>', () => {
    const out = withCropMarks('<body class="r">x</body>', true);
    expect(out).toContain('<body class="r">');
    expect(out).toContain(`<style>${CROP_MARKS_CSS}</style>`);
    expect(out.indexOf('<body')).toBeLessThan(out.indexOf(CROP_MARKS_CSS));
  });

  it('wraps a bare fragment in a full document', () => {
    const out = withCropMarks('just text', true);
    expect(out).toContain('<!doctype html>');
    expect(out).toContain(`<style>${CROP_MARKS_CSS}</style>`);
    expect(out).toContain('just text');
  });

  it('uses crop + cross marks (corner and center)', () => {
    expect(CROP_MARKS_CSS).toMatch(/marks:\s*crop cross/);
  });
});
