import { afterEach, describe, expect, it } from 'vitest';
import { __forTest, toFilledWithDiagnostics } from '../src/lib/fillJinja';
import { htmlWorkerImpl } from '../src/workers/htmlWorkerImpl';

afterEach(() => __forTest.setEmitHook(null));

describe('toFilled の自己検査', () => {
  it('正しい出力では固めない', () => {
    const r = toFilledWithDiagnostics('<div>{% if a %}<p>A</p>{% endif %}</div>', { a: true });
    expect(r.diagnostics.frozen).toEqual([]);
  });
  it('印の組み立てが壊れたら本文全体を固める', () => {
    __forTest.setEmitHook((h) => h.replace(/<!--jinja-rt:c:[^>]*-->/, ''));
    const r = toFilledWithDiagnostics('<div>{% if a %}<p>A</p>{% endif %}</div>', { a: true });
    expect(r.diagnostics.frozen).toEqual([{ tag: 'body', reason: 'self-check' }]);
    expect(r.html).toContain('jinja-frozen-body');
  });
  it('固めて描き直すときは評価の量を持ち越さず、診断は両方を合わせる', () => {
    // 1 回目で評価の量の上限(200 万)の 9 割を使う本文。持ち越すと 2 回目の表示が上限で欠ける。
    __forTest.setEmitHook((h) => h.replace(/<!--jinja-rt:c:[^>]*-->/, ''));
    const raw =
      '<div>{% if a %}<p>A</p>{% endif %}' +
      '{% for i in range(9) %}<i>{{ range(100000)|length }}</i>{% endfor %}{{ nope }}</div>';
    const r = toFilledWithDiagnostics(raw, { a: true });
    expect(r.diagnostics.frozen).toEqual([{ tag: 'body', reason: 'self-check' }]);
    expect(r.diagnostics.unsupported).toEqual([]);
    expect(r.diagnostics.missing).toEqual(['nope']);
    expect(r.html.match(/<i>100000<\/i>/g)?.length).toBe(9);
  });
  it('配列リテラルの倍化でも例外を外へ出さず、unsupported に数える', () => {
    let raw = '{% set b0 = range(1000) %}';
    for (let k = 1; k <= 20; k++) raw += `{% set b${k} = [b${k - 1}, b${k - 1}] %}`;
    raw += '<p>{{ b20 }}</p>';
    const r = toFilledWithDiagnostics(raw, {});
    expect(r.html.length).toBeLessThan(10_000_000);
    expect(r.diagnostics.unsupported.length).toBeGreaterThan(0);
  });
  it('Worker の実装(linkedom)からも呼べる', () => {
    expect(htmlWorkerImpl.toFilled('<p>{{ a }}</p>', { a: 1 })).toContain('>1<');
  });
});
