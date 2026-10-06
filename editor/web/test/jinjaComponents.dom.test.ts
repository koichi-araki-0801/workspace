// =============================================================================
// jinjaComponents.dom.test.ts — 固めた要素と埋め込みチップの GrapesJS 部品型
// =============================================================================
// 主張は 3 つ。
//   1. 固めた要素(表・SVG・本文全体を包む div)は部品自身は選べるが、子孫は選べず編集もできない。
//      子孫にスタイルを当てられると自動 id と `#id` 規則が残り、保存で原文へ戻ったあとも規則だけが
//      CSS に残るため。
//   2. GrapesJS を通した保存出力は `toTemplate` で原文へ戻る(範囲の印のコメントも書き出される)。
//   3. レイヤー名は「編集不可（Jinja）」。
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { JINJA_COMPONENT_TYPES } from '@/features/editor/jinjaComponents';
import { useGrapes } from '@/features/editor/useGrapes';
import { b64encode, toTemplate } from '@/lib/jinjaMask';

const LOCKED_PROPS = [
  'selectable',
  'hoverable',
  'editable',
  'droppable',
  'draggable',
  'removable',
  'copyable',
  'stylable',
] as const;

/** 部品の子孫を深さ優先で列挙する(部品自身は含まない)。 */
function descendants(c: Component): Component[] {
  return c.components().models.flatMap((ch) => [ch, ...descendants(ch)]);
}

let g: ReturnType<typeof useGrapes>;

beforeEach(() => {
  g = useGrapes();
  g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
});

// `Component.find` は描画済みの view の DOM を引くので、jsdom では iframe 越しに何も返らない。
// 型の判定はモデルで済むので、モデルの木をたどって探す。
const opaqueComponents = (): Component[] => {
  const w = g.editor.value?.getWrapper();
  return w ? descendants(w).filter((c) => c.getAttributes()['data-opaque'] !== undefined) : [];
};

describe('固めた部品の型', () => {
  it('型を登録し、刈り取りの許可にも入る', () => {
    expect(JINJA_COMPONENT_TYPES).toEqual(
      expect.arrayContaining(['jinja-frozen', 'jinja-frozen-svg', 'jinja-rawtext']),
    );
    const dc = g.editor.value?.DomComponents;
    for (const t of ['jinja-frozen', 'jinja-frozen-svg', 'jinja-rawtext']) {
      expect(dc?.getType(t), t).toBeTruthy();
    }
  });

  it('固めた表の子孫は選べず、保存は原文に戻る', () => {
    const raw = '<table><tbody>{% for r in rows %}{{ r }}{% endfor %}</tbody></table>';
    g.load(
      `<table data-gjs-type="jinja-frozen" data-opaque="${b64encode(raw)}" data-opaque-kind="frozen"><tbody><tr><td>1</td></tr></tbody></table>`,
      '',
    );
    const frozen = opaqueComponents()[0];
    expect(frozen?.get('type')).toBe('jinja-frozen');
    expect(frozen?.get('selectable')).not.toBe(false);
    expect(frozen?.get('removable')).toBe(true);
    expect(frozen?.get('draggable')).toBe(true);
    expect(frozen?.get('stylable')).toBe(false);
    expect(frozen?.get('editable')).toBe(false);
    expect(frozen?.get('droppable')).toBe(false);
    expect(frozen?.get('copyable')).toBe(false);
    const cell = descendants(frozen as Component).find((c) => c.get('tagName') === 'td');
    expect(cell?.get('selectable')).toBe(false);
    expect(cell?.get('editable')).toBe(false);
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(raw);
  });

  it('子孫は 8 つの操作可否がすべて止まる(テキストノードを含む)', () => {
    g.load(
      `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode('<table><tr><td><b>x</b></td></tr></table>')}" data-opaque-kind="frozen"><table><tbody><tr><td><b>x</b> y</td></tr></tbody></table></div>`,
      '',
    );
    const frozen = opaqueComponents()[0];
    expect(frozen?.get('type')).toBe('jinja-frozen');
    const all = descendants(frozen as Component);
    expect(all.length).toBeGreaterThan(4);
    for (const d of all) {
      for (const p of LOCKED_PROPS) expect(d.get(p), `${d.get('tagName')}.${p}`).toBe(false);
    }
  });

  it('固めた SVG は svg 型を継ぎ、子孫は選べない', () => {
    const raw = '<svg viewBox="0 0 10 10"><rect width="{{ w }}" height="1"></rect></svg>';
    g.load(
      `<svg data-gjs-type="jinja-frozen-svg" data-opaque="${b64encode(raw)}" data-opaque-kind="frozen" viewBox="0 0 10 10"><rect width="3" height="1"></rect></svg>`,
      '',
    );
    const frozen = opaqueComponents()[0];
    expect(frozen?.get('type')).toBe('jinja-frozen-svg');
    expect(frozen?.getName()).toBe('編集不可（Jinja）');
    expect(frozen?.get('stylable')).toBe(false);
    const rect = frozen?.components().at(0);
    expect(rect?.get('selectable')).toBe(false);
    expect(rect?.get('stylable')).toBe(false);
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(raw);
  });

  it('埋め込みチップ(style など)は jinja-rawtext 型で、原文へ戻る', () => {
    const raw = '<style>.a{color:{{ c }}}</style>';
    g.load(
      `<p>x<span data-gjs-type="jinja-rawtext" class="jinja-chip jinja-rawtext" data-opaque="${b64encode(raw)}" data-opaque-kind="rawtext">style</span></p>`,
      '',
    );
    const chip = opaqueComponents()[0];
    expect(chip?.get('type')).toBe('jinja-rawtext');
    expect(chip?.getName()).toBe('埋め込み（CSS 等）');
    expect(chip?.get('editable')).toBe(false);
    expect(chip?.get('copyable')).toBe(false);
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(`<p>x${raw}</p>`);
  });

  it('範囲の印のコメントを GrapesJS がそのまま書き出す', () => {
    g.load(
      '<table><tbody><!--jinja-rt:o:1:eyUgZm9yIHIgaW4gcm93cyAlfQ==--><tr data-jinja-loop-row=""><td>1</td></tr><!--jinja-rt:c:1:eyUgZW5kZm9yICV9--></tbody></table>',
      '',
    );
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(
      '<table><tbody>{% for r in rows %}<tr><td>1</td></tr>{% endfor %}</tbody></table>',
    );
  });

  it('固めた部品のレイヤー名は「編集不可（Jinja）」', () => {
    g.load(
      `<table data-gjs-type="jinja-frozen" data-opaque="${b64encode('<table></table>')}" data-opaque-kind="frozen"></table>`,
      '',
    );
    expect(opaqueComponents()[0]?.getName()).toBe('編集不可（Jinja）');
  });
});
