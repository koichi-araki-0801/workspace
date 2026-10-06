import { EDITING_MARKER_ATTRS } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import * as A from '../src/lib/jinjaAttrs';

describe('範囲の印の書式', () => {
  it('作って読むと元に戻る(日本語・空白制御を含む)', () => {
    for (const m of [
      { kind: 'o', id: 3, payload: '{%- if a -%}<p>前</p>{% elif b %}' },
      { kind: 'c', id: 3, payload: '{% else %}<p>後</p>{% endif %}' },
      { kind: 'x', id: 12 },
      { kind: 't', payload: '{# メモ #}' },
    ] as const) {
      const html = A.rtComment(m);
      expect(html.startsWith('<!--jinja-rt:') && html.endsWith('-->')).toBe(true);
      expect(html.slice(4, -3)).not.toMatch(/--|>/);
      expect(A.parseRtCommentData(html.slice(4, -3))).toEqual(m);
    }
  });

  it('jinja-rt: でないコメントは null、崩れた形は invalid', () => {
    expect(A.parseRtCommentData(' 通常のコメント ')).toBeNull();
    expect(A.parseRtCommentData('jinja-rt:o:1')).toBe('invalid');
    expect(A.parseRtCommentData('jinja-rt:o:x:YQ==')).toBe('invalid');
    expect(A.parseRtCommentData('jinja-rt:z:1:YQ==')).toBe('invalid');
    expect(A.parseRtCommentData('jinja-rt:t:!!!')).toBe('invalid');
  });

  it('空の t と不正な UTF-8 は invalid', () => {
    expect(A.parseRtCommentData('jinja-rt:t:')).toBe('invalid');
    expect(A.parseRtCommentData(`jinja-rt:t:${btoa('\xff\xfe')}`)).toBe('invalid');
  });

  it('web の属性名はすべて shared の検出対象に入っている', () => {
    for (const name of [A.DATA_JINJA, A.DATA_JINJA_LOOP_ROW, A.DATA_OPAQUE, A.DATA_OPAQUE_KIND])
      expect(EDITING_MARKER_ATTRS).toContain(name);
  });
});
