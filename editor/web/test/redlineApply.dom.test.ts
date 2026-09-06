import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRedline,
  clearRedline,
  clearRedlineWithin,
  REDLINE_ADDED_ATTR,
  REDLINE_ATTR,
  REDLINE_BLOCK_CLASS,
  REDLINE_HIGHLIGHT,
} from '@/features/editor/redline/redlineApply';
import { REDLINE_BODY_CLASS, redlineCanvasCss } from '@/features/editor/redline/redlineCss';
import type { RedlineOp } from '@/features/editor/redline/redlineDiff';

function root(html: string): HTMLElement {
  const r = document.createElement('div');
  r.innerHTML = html;
  document.body.appendChild(r);
  return r;
}
const textOf = (el: Element): Text => el.firstChild as Text;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('applyRedline — delText', () => {
  it('削除語句を新文言の直前へ <del data-redline contenteditable=false> として割り込ませる', () => {
    const r = root('<p>受益者の皆様へ</p>');
    const p = r.querySelector('p') as HTMLElement;
    const ops: RedlineOp[] = [
      {
        kind: 'delText',
        node: () => textOf(p),
        ops: [
          { type: 'same', text: '受' },
          { type: 'same', text: '益' },
          { type: 'same', text: '者' },
          { type: 'same', text: 'の' },
          { type: 'del', text: 'み' },
          { type: 'del', text: 'な' },
          { type: 'del', text: 'さ' },
          { type: 'del', text: 'ま' },
          { type: 'ins', text: '皆' },
          { type: 'ins', text: '様' },
          { type: 'same', text: 'へ' },
        ],
      },
    ];
    applyRedline(r, ops);
    const del = p.querySelector(`del[${REDLINE_ATTR}]`) as HTMLElement;
    expect(del).not.toBeNull();
    expect(del.textContent).toBe('みなさま');
    expect(del.getAttribute('contenteditable')).toBe('false');
    expect(del.classList.contains(REDLINE_BLOCK_CLASS)).toBe(false);
    // 表示上の並び: 受益者の[みなさま]皆様へ
    expect(p.textContent).toBe('受益者のみなさま皆様へ');
    // 先頭の Text ノード（GrapesJS の view が持つ参照）はそのまま残っている
    expect(p.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect((p.firstChild as Text).data).toBe('受益者の');
  });

  it('先頭 / 末尾の削除は Text を分割せずに前後へ置く', () => {
    const r = root('<p>bc</p><p>ab</p>');
    const [p1, p2] = Array.from(r.querySelectorAll('p')) as HTMLElement[];
    applyRedline(r, [
      {
        kind: 'delText',
        node: () => textOf(p1),
        ops: [
          { type: 'del', text: 'a' },
          { type: 'same', text: 'bc' },
        ],
      },
      {
        kind: 'delText',
        node: () => textOf(p2),
        ops: [
          { type: 'same', text: 'ab' },
          { type: 'del', text: 'c' },
        ],
      },
    ]);
    expect(p1.innerHTML).toBe(`<del ${REDLINE_ATTR}="" contenteditable="false">a</del>bc`);
    expect(p2.innerHTML).toBe(`ab<del ${REDLINE_ATTR}="" contenteditable="false">c</del>`);
    expect(p1.childNodes).toHaveLength(2);
    expect(p2.childNodes).toHaveLength(2);
  });

  it('node が null や Text でないときは何もしない（例外を出さない）', () => {
    const r = root('<p>x</p>');
    expect(() =>
      applyRedline(r, [
        { kind: 'delText', node: () => null, ops: [{ type: 'del', text: 'a' }] },
        { kind: 'delText', node: () => r.querySelector('p'), ops: [{ type: 'del', text: 'a' }] },
      ]),
    ).not.toThrow();
    expect(r.querySelector(`[${REDLINE_ATTR}]`)).toBeNull();
  });
});

describe('applyRedline — 要素', () => {
  it('addedEl は live 要素へ属性を付け、removedEl は基準の定義を <del class=redline-block> で挿す', () => {
    const r = root('<div class="page"><p id="a">A</p><p id="c">C</p></div>');
    const page = r.querySelector('.page') as HTMLElement;
    const c = r.querySelector('#c') as HTMLElement;
    applyRedline(r, [
      { kind: 'addedEl', node: () => c },
      {
        kind: 'removedEl',
        parent: () => page,
        before: () => c,
        inline: false,
        def: { tagName: 'p', components: { type: 'textnode', content: 'B' } },
      },
      { kind: 'removedEl', parent: null, before: null, inline: true, text: 'tail' },
    ]);
    expect(c.hasAttribute(REDLINE_ADDED_ATTR)).toBe(true);
    const block = page.querySelector(`del.${REDLINE_BLOCK_CLASS}[${REDLINE_ATTR}]`) as HTMLElement;
    expect(block.nextElementSibling).toBe(c);
    expect(block.textContent).toBe('B');
    expect(block.getAttribute('contenteditable')).toBe('false');
    // parent=null はルート末尾。inline はブロッククラス無し
    const tail = r.lastElementChild as HTMLElement;
    expect(tail.tagName).toBe('DEL');
    expect(tail.textContent).toBe('tail');
    expect(tail.classList.contains(REDLINE_BLOCK_CLASS)).toBe(false);
  });
});

describe('applyRedline — insText と CSS Highlight', () => {
  it('CSS.highlights が無い環境では例外を出さず何もしない', () => {
    const r = root('<p>abc</p>');
    const p = r.querySelector('p') as HTMLElement;
    expect(() =>
      applyRedline(r, [
        {
          kind: 'insText',
          node: () => textOf(p),
          ops: [
            { type: 'same', text: 'ab' },
            { type: 'ins', text: 'c' },
          ],
        },
      ]),
    ).not.toThrow();
    expect(p.innerHTML).toBe('abc');
  });

  it('CSS.highlights があれば挿入語句の Range を登録し、clearRedline で消す', () => {
    const r = root('<p>abc</p>');
    const p = r.querySelector('p') as HTMLElement;
    const ranges: Range[] = [];
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      add(range: Range) {
        ranges.push(range);
      }
    }
    // jsdom は `Highlight` も `CSS.highlights` も持たない。実装は `doc.defaultView`（= jsdom では
    // globalThis）から読むので、グローバルを差し替えて API がある環境を再現する。
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights: registry });
    try {
      applyRedline(r, [
        {
          kind: 'insText',
          node: () => textOf(p),
          ops: [
            { type: 'same', text: 'ab' },
            { type: 'ins', text: 'c' },
          ],
        },
      ]);
      expect(registry.has(REDLINE_HIGHLIGHT)).toBe(true);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startOffset).toBe(2);
      expect(ranges[0].endOffset).toBe(3);
      clearRedline(r);
      expect(registry.has(REDLINE_HIGHLIGHT)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('clearRedline / clearRedlineWithin', () => {
  it('装飾を全て外し、分割した Text を結合して元の innerHTML に戻す', () => {
    const r = root('<div class="page"><p>受益者の皆様へ</p><p class="k">keep</p></div>');
    const before = r.innerHTML;
    const p = r.querySelector('p') as HTMLElement;
    const k = r.querySelector('.k') as HTMLElement;
    applyRedline(r, [
      {
        kind: 'delText',
        node: () => textOf(p),
        ops: [
          { type: 'same', text: '受益者の' },
          { type: 'del', text: 'みなさま' },
          { type: 'same', text: '皆様へ' },
        ],
      },
      { kind: 'addedEl', node: () => k },
      {
        kind: 'removedEl',
        parent: () => r.firstElementChild as HTMLElement,
        before: () => k,
        inline: false,
        def: { tagName: 'p', content: 'gone' },
      },
    ]);
    expect(r.innerHTML).not.toBe(before);
    clearRedline(r);
    expect(r.innerHTML).toBe(before);
    expect(p.childNodes).toHaveLength(1);
  });

  it('clearRedlineWithin は指定要素の配下だけを戻す', () => {
    const r = root('<div class="page"><p>ab</p><p>cd</p></div>');
    const [p1, p2] = Array.from(r.querySelectorAll('p')) as HTMLElement[];
    applyRedline(r, [
      {
        kind: 'delText',
        node: () => textOf(p1),
        ops: [
          { type: 'del', text: 'x' },
          { type: 'same', text: 'ab' },
        ],
      },
      {
        kind: 'delText',
        node: () => textOf(p2),
        ops: [
          { type: 'del', text: 'y' },
          { type: 'same', text: 'cd' },
        ],
      },
    ]);
    clearRedlineWithin(p1);
    expect(p1.innerHTML).toBe('ab');
    expect(p2.querySelector(`[${REDLINE_ATTR}]`)).not.toBeNull();
  });
});

describe('redlineCanvasCss', () => {
  it('表示は body クラスで出し分け、OFF では del を display:none にする', () => {
    expect(redlineCanvasCss).toContain(`.${REDLINE_BODY_CLASS} [${REDLINE_ATTR}]`);
    expect(redlineCanvasCss).toContain('line-through');
    expect(redlineCanvasCss).toContain(`body:not(.${REDLINE_BODY_CLASS}) [${REDLINE_ATTR}]`);
    expect(redlineCanvasCss).toContain(`::highlight(${REDLINE_HIGHLIGHT})`);
    expect(redlineCanvasCss).toContain(`[${REDLINE_ADDED_ATTR}]`);
  });
});
