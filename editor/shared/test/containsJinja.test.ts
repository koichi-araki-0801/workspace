import { describe, expect, it } from 'vitest';
import { containsJinja } from '../src/jinja/containsJinja';

describe('containsJinja', () => {
  it('3 種のタグのどれかがあれば true', () => {
    expect(containsJinja('<p>{{ fund.name }}</p>')).toBe(true);
    expect(containsJinja('<p>{% if a %}x{% endif %}</p>')).toBe(true);
    expect(containsJinja('<p>{# メモ #}</p>')).toBe(true);
  });

  it('タグが無ければ false(波括弧 1 つは Jinja ではない)', () => {
    expect(containsJinja('<p>注記 { 1 }</p>')).toBe(false);
    expect(containsJinja('')).toBe(false);
  });

  it('閉じていない開き記号は Jinja を含む側に倒す', () => {
    expect(containsJinja('<p>{{ fund.name </p>')).toBe(true);
  });
});
