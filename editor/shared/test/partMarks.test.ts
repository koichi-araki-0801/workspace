// =============================================================================
// partMarks.test.ts — 変更パーツの番号の振り方とパーツ名
// =============================================================================
// 差分(`HtmlDiff`)は `reviewedCandidate.test.ts` と同じく手で組む。DOM は shared のテスト環境に
// 無いので、名前の走査は最小の偽ノードで確かめる(実 DOM での確認は web の htmlBlockDiff.dom.test)。

import { describe, expect, it } from 'vitest';
import type { DiffBlock, DiffPage, HtmlDiff } from '../src/html/reviewDiff/htmlDiff';
import {
  numberChangedParts,
  partDisplayName,
  partNameFromText,
  partNameOfElement,
  partNameOfHtml,
} from '../src/html/reviewDiff/partMarks';

function block(key: string, status: DiffBlock['status']): DiffBlock {
  const before = status === 'added' ? '' : `<p>${key}旧</p>`;
  const after = status === 'removed' ? '' : `<p>${key}新</p>`;
  return {
    key,
    partKey: key,
    beforePartKey: status === 'added' ? null : key,
    status,
    beforeHtml: before,
    afterHtml: after,
    rawBeforeHtml: before,
    rawAfterHtml: after,
    label: key,
    coarse: false,
    beforeUnit: null,
    afterUnit: null,
    beforeBreakAfter: false,
    afterBreakAfter: false,
  };
}

function page(index: number, blocks: DiffBlock[], beforeKeys: string[], afterKeys: string[]) {
  const p: DiffPage = {
    index,
    changed: blocks.some((b) => b.status !== 'same'),
    changedBlockCount: blocks.filter((b) => b.status !== 'same').length,
    blocks,
    beforeKeys,
    afterKeys,
    coarse: false,
    beforeHtml: '',
    afterHtml: '',
    afterBreakUnit: null,
  };
  return p;
}

function diffOf(pages: DiffPage[]): HtmlDiff {
  return {
    pages,
    changedPageCount: pages.filter((p) => p.changed).length,
    beforePageCount: pages.length,
    afterPageCount: pages.length,
    coarse: false,
    truncated: false,
  };
}

// 偽ノード(DOM の `nodeType` / `childNodes` / `hasAttribute` / `textContent` だけを持つ)。
type Fake = {
  nodeType: number;
  childNodes: Fake[];
  textContent?: string;
  hasAttribute: (name: string) => boolean;
};
const text = (t: string): Fake => ({
  nodeType: 3,
  childNodes: [],
  textContent: t,
  hasAttribute: () => false,
});
const el = (attrs: string[], ...children: Fake[]): Fake => ({
  nodeType: 1,
  childNodes: children,
  hasAttribute: (name) => attrs.includes(name),
});
const asEl = (f: Fake) => f as unknown as Element;

describe('numberChangedParts', () => {
  it('変更のあるパーツにページ順・紙面の並び順で 1 から振る', () => {
    const diff = diffOf([
      page(
        0,
        [
          block('a#1', 'same'),
          block('b#1', 'changed'),
          block('d#1', 'added'),
          block('c#1', 'removed'),
        ],
        ['a#1', 'b#1', 'c#1'],
        ['a#1', 'b#1', 'd#1'],
      ),
    ]);
    const parts = numberChangedParts(diff);
    expect(parts.map((p) => [p.no, p.partKey, p.kind])).toEqual([
      [1, 'b#1', 'changed'],
      [2, 'c#1', 'removed'],
      [3, 'd#1', 'added'],
    ]);
    expect(parts[1]).toMatchObject({ beforePage: 0, afterPage: null, afterHtml: '' });
    expect(parts[2]).toMatchObject({ beforePage: null, afterPage: 0, beforePartKey: null });
  });

  it('ページをまたいで動いたパーツは 1 つだけ番号を振る', () => {
    const diff = diffOf([
      page(0, [block('x#1', 'removed')], ['x#1'], []),
      page(1, [block('x#1', 'added')], [], ['x#1']),
    ]);
    expect(numberChangedParts(diff)).toEqual([
      expect.objectContaining({
        no: 1,
        partKey: 'x#1',
        kind: 'changed',
        beforePage: 0,
        afterPage: 1,
        beforePartKey: 'x#1',
        beforeHtml: '<p>x#1旧</p>',
        afterHtml: '<p>x#1新</p>',
      }),
    ]);
  });

  it('追加側が先に現れても左右のページを埋める', () => {
    const diff = diffOf([
      page(0, [block('x#1', 'added')], [], ['x#1']),
      page(1, [block('x#1', 'removed')], ['x#1'], []),
    ]);
    expect(numberChangedParts(diff)).toEqual([
      expect.objectContaining({
        kind: 'changed',
        beforePage: 1,
        afterPage: 0,
        beforePartKey: 'x#1',
      }),
    ]);
  });

  it('パーツに数えない block(#attached#・#text#)の変更にも番号を振る', () => {
    const diff = diffOf([
      page(
        0,
        [block('p#1', 'same'), block('#attached#1', 'changed'), block('#text#1', 'added')],
        ['p#1', '#attached#1'],
        ['p#1', '#attached#1', '#text#1'],
      ),
    ]);
    expect(numberChangedParts(diff).map((p) => [p.no, p.partKey, p.kind])).toEqual([
      [1, '#attached#1', 'changed'],
      [2, '#text#1', 'added'],
    ]);
  });

  it('same だけの差分は空', () => {
    const sameOnly = diffOf([page(0, [block('a#1', 'same')], ['a#1'], ['a#1'])]);
    expect(numberChangedParts(sameOnly)).toEqual([]);
  });
});

describe('partNameFromText', () => {
  it('空白を詰め、20 文字を超えたら … で切る', () => {
    expect(partNameFromText('  受益者の  皆様へ ')).toBe('受益者の 皆様へ');
    expect(partNameFromText('あ'.repeat(20))).toBe('あ'.repeat(20));
    expect(partNameFromText('あ'.repeat(21))).toBe(`${'あ'.repeat(20)}…`);
  });
});

describe('partNameOfElement / partNameOfHtml', () => {
  it('最初の空でないテキストノードを使う(表は最初のセル)', () => {
    const table = el([], el([], el([], text('\n  '), el([], text('基準価額')))), text('他'));
    expect(partNameOfElement(asEl(table))).toBe('基準価額');
  });
  it('赤入れの旧文言(data-redline)は読まない', () => {
    const p = el([], el(['data-redline'], text('みなさま')), text('皆様へ'));
    expect(partNameOfElement(asEl(p))).toBe('皆様へ');
  });
  it('文字が無ければ空', () => {
    expect(partNameOfElement(asEl(el([], text(' '), el([]))))).toBe('');
  });
  it('partNameOfHtml は渡されたパーサの body を読む', () => {
    const parse = () => ({ body: el([], text('見出し')) }) as unknown as Document;
    expect(partNameOfHtml('<h1>見出し</h1>', parse)).toBe('見出し');
  });
});

describe('partDisplayName', () => {
  it('名前は業務名 → 先頭の文字 → 「ページN・パーツM」の順', () => {
    const fallbackLabel = 'ページ1・パーツ4';
    expect(
      partDisplayName({ catalogName: '基準価額表', firstText: '基準価額', fallbackLabel }),
    ).toBe('基準価額表');
    expect(partDisplayName({ catalogName: '', firstText: '基準価額', fallbackLabel })).toBe(
      '基準価額',
    );
    expect(partDisplayName({ firstText: '', fallbackLabel })).toBe(fallbackLabel);
  });
});
