import type { Component, ComponentDefinition } from 'grapesjs';
import { describe, expect, it } from 'vitest';
import {
  fromComponents,
  fromDefinitions,
  renderDefinition,
} from '@/features/editor/redline/redlineTree';

/** GrapesJS パーサが返す定義の形（子テキスト 1 つは配列でなくオブジェクト）を手で組む。 */
const textDef = (content: string): ComponentDefinition => ({ type: 'textnode', content });

describe('fromDefinitions', () => {
  it('要素は rawKey#n、テキストは #text#n のキーになり、空白のみテキストは除く', () => {
    const defs: ComponentDefinition[] = [
      { tagName: 'div', attributes: { 'data-part-id': 'cover' }, components: [textDef(' ')] },
      {
        tagName: 'p',
        classes: ['lead'],
        components: [textDef('a'), { tagName: 'b', components: textDef('x') }, textDef('c')],
      },
      { tagName: 'p', classes: ['lead'], components: textDef('second') },
    ];
    const t = fromDefinitions(defs);
    expect(t.map((n) => n.key)).toEqual(['cover#1', '.lead#1', '.lead#2']);
    expect(t[0].children).toEqual([]);
    expect(t[1].children.map((n) => n.key)).toEqual(['#text#1', 'b#1', '#text#2']);
    expect(t[1].children[0].text).toBe('a');
    expect(t[1].children[1].children[0].text).toBe('x');
  });

  it('components がオブジェクト 1 個でも配列でも同じ木になる', () => {
    const a = fromDefinitions([{ tagName: 'p', components: textDef('hi') }]);
    const b = fromDefinitions([{ tagName: 'p', components: [textDef('hi')] }]);
    expect(a[0].children.map((n) => n.text)).toEqual(['hi']);
    expect(b[0].children.map((n) => n.text)).toEqual(['hi']);
  });

  it('text 型で子が無く content だけ持つ要素は content をテキスト子へ正規化する', () => {
    const t = fromDefinitions([{ tagName: 'p', type: 'text', content: 'body' }]);
    expect(t[0].children).toHaveLength(1);
    expect(t[0].children[0]).toMatchObject({ kind: 'text', key: '#text#1', text: 'body' });
  });

  it('jinja chip は要素として保持し、classes が {name} 形式でも先頭 class を読む', () => {
    const t = fromDefinitions([
      {
        tagName: 'span',
        type: 'jinja-var',
        classes: [{ name: 'jinja-chip' }, { name: 'jinja-var' }] as unknown as string[],
        attributes: { 'data-jinja': '{{ fund.name }}' },
        components: textDef('ファンドA'),
      },
    ]);
    expect(t[0]).toMatchObject({ kind: 'el', key: '.jinja-chip#1', tag: 'span' });
    expect(t[0].children[0].text).toBe('ファンドA');
    expect(t[0].node()).toBeNull();
    expect(t[0].def).toBeDefined();
  });
});

/** GrapesJS Component の最小フェイク（読むメソッドだけ）。 */
function fakeComp(o: {
  type?: string;
  tagName?: string;
  attributes?: Record<string, string>;
  classes?: string[];
  content?: string;
  children?: Component[];
  el?: Node | null;
}): Component {
  const kids = o.children ?? [];
  return {
    get: (k: string) => (o as Record<string, unknown>)[k],
    getClasses: () => o.classes ?? [],
    components: () => ({ length: kids.length, map: <T>(f: (c: Component) => T) => kids.map(f) }),
    getEl: () => o.el ?? null,
  } as unknown as Component;
}

describe('fromComponents', () => {
  it('モデル木を同じ形へ写し、node が live の要素 / Text を返す', () => {
    const p = document.createElement('p');
    p.textContent = 'hello';
    const textEl = p.firstChild as Text;
    const root = fakeComp({
      type: 'wrapper',
      children: [
        fakeComp({
          tagName: 'p',
          type: 'text',
          classes: ['lead'],
          // GrapesJS の自動 id は view の属性で、モデルの attributes には現れない。
          attributes: { 'data-x': '1' },
          el: p,
          children: [fakeComp({ type: 'textnode', content: 'hello', el: textEl })],
        }),
      ],
    });
    const t = fromComponents(root);
    expect(t.map((n) => n.key)).toEqual(['.lead#1']);
    expect(t[0].node()).toBe(p);
    expect(t[0].children[0]).toMatchObject({ kind: 'text', key: '#text#1', text: 'hello' });
    expect(t[0].children[0].node()).toBe(textEl);
  });

  it('text 型で子が無く content だけの Component は親 el の firstChild をテキストとして返す', () => {
    const p = document.createElement('p');
    p.textContent = 'body';
    const root = fakeComp({
      children: [fakeComp({ tagName: 'p', type: 'text', content: 'body', el: p })],
    });
    const t = fromComponents(root);
    expect(t[0].children[0].text).toBe('body');
    expect(t[0].children[0].node()).toBe(p.firstChild);
  });

  it('空白のみの textnode は除く', () => {
    const root = fakeComp({
      children: [fakeComp({ type: 'textnode', content: '\n  ' }), fakeComp({ tagName: 'hr' })],
    });
    expect(fromComponents(root).map((n) => n.key)).toEqual(['hr#1']);
  });
});

describe('renderDefinition', () => {
  it('定義から DOM を組み、本文と属性値はエスケープされた文字列のまま出る', () => {
    const node = renderDefinition(
      {
        tagName: 'p',
        classes: ['x'],
        attributes: {
          title: '"><img onerror=alert(1)>',
          id: 'dup',
          'data-gjs-type': 'text',
          onclick: 'x()',
        },
        components: [textDef('<img src=x onerror=alert(1)>'), { tagName: 'br' }],
      },
      document,
    );
    const el = node as HTMLElement;
    expect(el.tagName).toBe('P');
    expect(el.className).toBe('x');
    expect(el.getAttribute('title')).toBe('"><img onerror=alert(1)>');
    // id（重複 id を作らない）・`on*`・`data-gjs-*` は写さない
    expect(el.hasAttribute('id')).toBe(false);
    expect(el.hasAttribute('onclick')).toBe(false);
    expect(el.hasAttribute('data-gjs-type')).toBe(false);
    expect(el.querySelector('img')).toBeNull();
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.querySelector('br')).not.toBeNull();
  });
});
