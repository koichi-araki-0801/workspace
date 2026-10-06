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
  it('Worker の実装(linkedom)からも呼べる', () => {
    expect(htmlWorkerImpl.toFilled('<p>{{ a }}</p>', { a: 1 })).toContain('>1<');
  });
});
