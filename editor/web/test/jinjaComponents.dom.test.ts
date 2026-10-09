// =============================================================================
// jinjaComponents.dom.test.ts — 固めた要素と埋め込みチップの GrapesJS 部品型
// =============================================================================
// 主張は 3 つ。
//   1. 固めた要素(表・SVG・本文全体を包む div)は部品自身は選べるが、子孫は選べず編集もできない。
//      子孫にスタイルを当てられると自動 id と `#id` 規則が残り、保存で原文へ戻ったあとも規則だけが
//      CSS に残るため。
//   2. GrapesJS を通した保存出力は `toTemplate` で原文へ戻る(範囲の印のコメントも書き出される)。
//   3. レイヤー名は「編集不可（Jinja）」。
import fs from 'node:fs';
import path from 'node:path';
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { JINJA_COMPONENT_TYPES } from '@/features/editor/jinjaComponents';
import { useGrapes } from '@/features/editor/useGrapes';
import { b64encodeUtf8 as b64encode } from '@/lib/jinjaAttrs';
import { toTemplate } from '@/lib/jinjaMask';

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
      `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode('<table><tr><td><b>x</b></td></tr></table>')}" data-opaque-kind="body"><table><tbody><tr><td><b>x</b> y</td></tr></tbody></table></div>`,
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

  it('固めた SVG の子孫は SVG の部品(svg-in)で描かれ、選べず、原文へ戻る', () => {
    const raw =
      '<svg viewBox="0 0 10 10"><g><rect width="{{ w }}" height="1"></rect><text x="1">{{ v }}</text></g></svg>';
    const display =
      '<g class="bar"><rect width="3" height="1"></rect><text x="1">3</text>' +
      '<linearGradient id="lg" gradientUnits="userSpaceOnUse"><stop offset="0"></stop></linearGradient></g>';
    g.load(
      `<svg data-gjs-type="jinja-frozen-svg" data-opaque="${b64encode(raw)}" data-opaque-kind="frozen" viewBox="0 0 10 10">${display}</svg>`,
      '',
    );
    const frozen = opaqueComponents()[0] as Component;
    expect(frozen.get('type')).toBe('jinja-frozen-svg');
    expect(frozen.getName()).toBe('編集不可（Jinja）');
    expect(frozen.get('stylable')).toBe(false);
    // 継いだ `svg` 型のリサイズは inline style を書き、保存で黙って捨てられるので止める。
    expect(frozen.get('resizable')).toBe(false);
    const elements = descendants(frozen).filter((c) => c.get('type') !== 'textnode');
    expect(elements.map((c) => c.get('tagName'))).toEqual([
      'g',
      'rect',
      'text',
      'linearGradient',
      'stop',
    ]);
    // `svg-in` 系の型でないと子孫が XHTML の名前空間で作られ、canvas に図が描かれない。
    // jsdom では canvas の iframe が描かれないので、型の view で要素を作って名前空間を確かめる。
    type ViewCtor = new (o: { model: Component; config: object }) => { el: Element };
    const dc = g.editor.value?.DomComponents;
    const View = dc?.getType('jinja-frozen-svg-in')?.view as unknown as ViewCtor;
    const em = g.editor.value?.getModel();
    for (const c of elements) {
      expect(c.get('type'), c.get('tagName')).toBe('jinja-frozen-svg-in');
      expect(c.get('layerable'), c.get('tagName')).toBe(false);
      const v = new View({ model: c, config: { em } });
      expect(v.el.namespaceURI, c.get('tagName')).toBe('http://www.w3.org/2000/svg');
      expect(v.el.tagName).toBe(c.get('tagName'));
    }
    for (const d of descendants(frozen)) {
      for (const p of LOCKED_PROPS) expect(d.get(p), `${d.get('tagName')}.${p}`).toBe(false);
    }
    expect(g.getBodyHtml()).toContain(
      `<g class="bar"><rect width="3" height="1"></rect><text x="1">3</text>`,
    );
    expect(g.getBodyHtml()).toContain('<linearGradient id="lg" gradientUnits="userSpaceOnUse">');
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(raw);
  });

  it('固めていない SVG の子孫は GrapesJS 既定の svg-in のまま', () => {
    g.load('<svg viewBox="0 0 1 1"><g><rect width="1" height="1"></rect></g></svg>', '');
    const svg = g.editor.value?.getWrapper()?.components().at(0) as Component;
    expect(svg.get('type')).toBe('svg');
    for (const c of descendants(svg)) expect(c.get('type')).toBe('svg-in');
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

// GrapesJS は `data-gjs-type` を書き出さないので、Undo の snapshot・下書きの再読込・プレビューから
// の戻りで `load(getBodyHtml())` を通ると、型の指定が消えた HTML から作り直すことになる。
describe('書き出した HTML を読み直しても部品の型と固定が残る', () => {
  const allOf = (): Component[] => {
    const w = g.editor.value?.getWrapper();
    return w ? descendants(w) : [];
  };
  const typeOf = (pred: (c: Component) => boolean) => allOf().find(pred)?.get('type');
  const attr = (c: Component, k: string) => c.getAttributes()[k];
  const expectLocked = (root: Component) => {
    const all = descendants(root);
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      for (const p of LOCKED_PROPS) expect(d.get(p), `${d.get('tagName')}.${p}`).toBe(false);
    }
  };

  const table =
    '<table><tbody>{% for r in rows %}<tr><td>{{ r }}</td></tr>{% endfor %}</tbody></table>';
  const svgRaw = '<svg viewBox="0 0 10 10"><g><rect width="{{ w }}" height="1"></rect></g></svg>';
  const bodyRaw = '<p>{{ a }}</p>';
  const chip = (kind: string, src: string) =>
    `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-jinja="${b64encode(src)}">${src}</span>`;
  const opaqueChip = (kind: string, src: string) =>
    `<span data-gjs-type="jinja-${kind}" class="jinja-chip jinja-${kind}" data-opaque="${b64encode(src)}" data-opaque-kind="${kind}">L</span>`;
  const html =
    `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode(table)}" data-opaque-kind="frozen"><table><tbody><tr><td>1</td></tr></tbody></table></div>` +
    `<table data-gjs-type="jinja-frozen" data-opaque="${b64encode(table)}" data-opaque-kind="frozen"><tbody><tr><td>2</td></tr></tbody></table>` +
    `<svg data-gjs-type="jinja-frozen-svg" data-opaque="${b64encode(svgRaw)}" data-opaque-kind="frozen" viewBox="0 0 10 10"><g><rect width="3" height="1"></rect><linearGradient id="lg"><stop offset="0"></stop></linearGradient></g></svg>` +
    `<p>a${chip('var', '{{ v }}')}b${chip('stmt', '{% set x = 1 %}')}${chip('comment', '{# c #}')}` +
    `${opaqueChip('script', '<script>{{ s }}</script>')}${opaqueChip('math', '<math>{{ m }}</math>')}` +
    `${opaqueChip('rawtext', '<style>.a{color:{{ c }}}</style>')}</p>`;

  const checkTypes = () => {
    const frozen = allOf().filter((c) => attr(c, 'data-opaque-kind') === 'frozen');
    expect(frozen.map((c) => c.get('type'))).toEqual([
      'jinja-frozen',
      'jinja-frozen',
      'jinja-frozen-svg',
    ]);
    for (const f of frozen) expectLocked(f);
    const svg = frozen[2] as Component;
    const svgEls = descendants(svg).filter((c) => c.get('type') !== 'textnode');
    expect(svgEls.map((c) => c.get('tagName'))).toEqual(['g', 'rect', 'linearGradient', 'stop']);
    for (const c of svgEls) expect(c.get('type'), c.get('tagName')).toBe('jinja-frozen-svg-in');
    for (const kind of ['var', 'stmt', 'comment', 'script', 'math', 'rawtext']) {
      expect(
        typeOf((c) => (c.getClasses() as string[]).includes(`jinja-${kind}`)),
        kind,
      ).toBe(`jinja-${kind}`);
    }
  };

  it('前提: 書き出した HTML に data-gjs-type は残らない', () => {
    g.load(html, '');
    expect(g.getBodyHtml()).not.toContain('data-gjs-type');
  });

  it('固めた表・表を包む div・固めた SVG と子孫・各チップの型が読み直しで残る', () => {
    g.load(html, '');
    checkTypes();
    const out = g.getBodyHtml();
    g.load(out, '');
    checkTypes();
    expect(g.getBodyHtml()).toBe(out);
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(
      toTemplate(out, { asFragment: true }),
    );
  });

  it('本文全体を固めた div も読み直しで jinja-frozen のまま、子孫は止まったまま', () => {
    g.load(
      `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode(bodyRaw)}" data-opaque-kind="body"><p>1</p></div>`,
      '',
    );
    g.load(g.getBodyHtml(), '');
    const body = allOf().find((c) => attr(c, 'data-opaque-kind') === 'body') as Component;
    expect(body.get('type')).toBe('jinja-frozen');
    expectLocked(body);
    expect(toTemplate(g.getBodyHtml(), { asFragment: true })).toBe(bodyRaw);
  });

  it('印を持たない通常の要素は jinja の型に取られない', () => {
    g.load(
      '<span class="jinja-chip jinja-var">x</span><div data-opaque-kind="frozen"><p>y</p></div>' +
        '<svg viewBox="0 0 1 1"><g><rect width="1" height="1"></rect></g></svg>' +
        '<table><tbody><tr><td>z</td></tr></tbody></table>',
      '',
    );
    for (const c of allOf()) expect(String(c.get('type')), c.get('tagName')).not.toMatch(/^jinja-/);
  });

  it('編集タブの値入り HTML(fixtures/filled)は jinja の型を一つも持たない', () => {
    const dir = path.resolve(__dirname, '../src/api/fixtures/filled');
    const name = fs.readdirSync(dir).find((n) => n.endsWith('.html')) as string;
    const doc = fs.readFileSync(path.join(dir, name), 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(doc)?.[1] ?? '';
    expect(body.length).toBeGreaterThan(100);
    g.load(body, '');
    expect(allOf().length).toBeGreaterThan(10);
    for (const c of allOf()) expect(String(c.get('type')), c.get('tagName')).not.toMatch(/^jinja-/);
  });
});

// 編集可否の一括切替(`setEditable`)は読み込み直後と Undo / Redo のたびに走る。固めた要素の
// 子孫まで切り替えると、`init` で止めた選択・編集・移動が戻ってしまう。
describe('編集可否の切替が固めた要素の子孫の固定を上書きしない', () => {
  for (const on of [true, false]) {
    it(`setEditable(${on}) の後も子孫は止まったまま`, () => {
      g.load(
        `<div data-gjs-type="jinja-frozen" class="jinja-frozen-body" data-opaque="${b64encode('<table></table>')}" data-opaque-kind="frozen"><table><tbody><tr><td><b>1</b> 2</td></tr></tbody></table></div>` +
          `<svg data-gjs-type="jinja-frozen-svg" data-opaque="${b64encode('<svg></svg>')}" data-opaque-kind="frozen"><g><rect width="1"></rect></g></svg>` +
          `<p>a<span data-gjs-type="jinja-var" class="jinja-chip jinja-var" data-jinja="${b64encode('{{ v }}')}">v</span></p>`,
        '',
      );
      g.setEditable(on);
      for (const f of opaqueComponents()) {
        for (const d of descendants(f)) {
          for (const p of ['selectable', 'editable', 'draggable'] as const) {
            expect(d.get(p), `${d.get('tagName')}.${p}`).toBe(false);
          }
        }
      }
      const chip = descendants(g.editor.value?.getWrapper() as Component).find(
        (c) => c.get('type') === 'jinja-var',
      ) as Component;
      expect(chip.get('editable')).toBe(false);
      // 固めていない要素は切替どおりになる。
      const p = descendants(g.editor.value?.getWrapper() as Component).find(
        (c) => c.get('tagName') === 'p',
      ) as Component;
      expect(p.get('editable')).toBe(on);
    });
  }
});
