import { describe, expect, it } from 'vitest';
import { type OpenCanvasInput, openCanvas } from '@/features/editor/openCanvas';

/**
 * GrapesJS の代わり。読み込んだ本文と CSS を「書き直した形」(`gjs:` 前置き)で返し、
 * `EXTERNAL` を含む CSS は拒む(`load` が false)。読み込みの順を `loads` に残す。
 */
function fakeCanvas() {
  let body = '';
  let css = '';
  const loads: Array<{ body: string; css: string; quiet: boolean }> = [];
  return {
    loads,
    load(b: string, c: string, opts: { quiet?: boolean } = {}): boolean {
      if (c.includes('EXTERNAL')) return false;
      loads.push({ body: b, css: c, quiet: !!opts.quiet });
      body = b;
      css = c;
      return true;
    },
    getBodyHtml: () => `gjs:${body}`,
    getCss: () => `gjs:${css}`,
  };
}

const base: OpenCanvasInput = {
  isCreateRoute: false,
  hasDraft: false,
  confirmedBody: '<p>確定</p>',
  confirmedCss: '.a{color:#003366}',
  editableBody: '<p>確定</p>',
  css: '.a{color:#003366}',
  cachedCanonical: null,
};
const withDraft: OpenCanvasInput = {
  ...base,
  hasDraft: true,
  editableBody: '<p>下書き</p>',
  css: '.a{color:#000}',
};

describe('openCanvas', () => {
  it('下書きが無ければ 1 回だけ読み込み、その直後の CSS を baseline にする', () => {
    const g = fakeCanvas();
    const r = openCanvas(g, base);
    expect(g.loads).toEqual([{ body: '<p>確定</p>', css: '.a{color:#003366}', quiet: false }]);
    expect(r).toEqual({
      loaded: true,
      cssBaseline: 'gjs:.a{color:#003366}',
      canonical: { html: 'gjs:<p>確定</p>', css: 'gjs:.a{color:#003366}' },
      measuredCanonical: true,
      loadFailed: false,
    });
  });

  it('下書きを復元して開いても、baseline は確定版を読み込んだ直後の形(下書きの CSS ではない)', () => {
    const g = fakeCanvas();
    const r = openCanvas(g, withDraft);
    expect(g.loads).toEqual([
      { body: '<p>確定</p>', css: '.a{color:#003366}', quiet: true },
      { body: '<p>下書き</p>', css: '.a{color:#000}', quiet: false },
    ]);
    expect(r.cssBaseline).toBe('gjs:.a{color:#003366}');
    expect(r.canonical).toEqual({ html: 'gjs:<p>確定</p>', css: 'gjs:.a{color:#003366}' });
    expect(r.measuredCanonical).toBe(true);
    expect(r.loaded).toBe(true);
  });

  it('正規形のキャッシュがあっても、下書きから開くときは確定版を読み込んで baseline を測る', () => {
    const g = fakeCanvas();
    const cached = { html: 'cached-html', css: 'cached-css' };
    const r = openCanvas(g, { ...withDraft, cachedCanonical: cached });
    expect(g.loads.map((l) => l.quiet)).toEqual([true, false]);
    expect(r.cssBaseline).toBe('gjs:.a{color:#003366}');
    expect(r.canonical).toBe(cached);
    expect(r.measuredCanonical).toBe(false);
  });

  it('作成経路でも baseline を測り、正規形は作らない', () => {
    const g = fakeCanvas();
    const draft = openCanvas(g, { ...withDraft, isCreateRoute: true });
    expect(draft.cssBaseline).toBe('gjs:.a{color:#003366}');
    expect(draft.canonical).toBeNull();
    expect(draft.measuredCanonical).toBe(false);
    const clean = openCanvas(fakeCanvas(), { ...base, isCreateRoute: true });
    expect(clean.cssBaseline).toBe('gjs:.a{color:#003366}');
    expect(clean.canonical).toBeNull();
  });

  it('確定版を読み込めなければ baseline は null。キャッシュも無ければ loadFailed を立てる', () => {
    const input = { ...withDraft, confirmedCss: '.a{background:url(EXTERNAL)}' };
    const r = openCanvas(fakeCanvas(), input);
    expect(r).toMatchObject({ loaded: true, cssBaseline: null, canonical: null, loadFailed: true });
    const cached = { html: 'h', css: 'c' };
    const r2 = openCanvas(fakeCanvas(), { ...input, cachedCanonical: cached });
    expect(r2).toMatchObject({ cssBaseline: null, canonical: cached, loadFailed: false });
    // 作成経路は正規形を使わないので loadFailed は立てない。
    const r3 = openCanvas(fakeCanvas(), { ...input, isCreateRoute: true });
    expect(r3).toMatchObject({ cssBaseline: null, loadFailed: false });
  });

  it('本文の読み込みを拒まれたら loaded=false で、何も測らない', () => {
    const r = openCanvas(fakeCanvas(), { ...base, css: 'EXTERNAL' });
    expect(r).toEqual({
      loaded: false,
      cssBaseline: null,
      canonical: null,
      measuredCanonical: false,
      loadFailed: false,
    });
  });
});
