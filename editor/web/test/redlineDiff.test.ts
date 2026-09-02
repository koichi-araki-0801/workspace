import { describe, expect, it } from 'vitest';
import { createLcsBudget, MAX_LCS_CELLS } from '@/features/compare/htmlBlockDiff';
import { diffRedline } from '@/features/editor/redline/redlineDiff';
import type { NodeResolver, RedlineNode } from '@/features/editor/redline/redlineTree';

const NIL: NodeResolver = () => null;
const el = (
  key: string,
  children: RedlineNode[] = [],
  node: NodeResolver = NIL,
  tag = 'p',
): RedlineNode => ({
  kind: 'el',
  key,
  tag,
  children,
  node,
  def: { tagName: tag },
});
const tx = (key: string, text: string, node: NodeResolver = NIL): RedlineNode => ({
  kind: 'text',
  key,
  text,
  children: [],
  node,
});
const ref = (): NodeResolver => {
  const n = document.createElement('span');
  return () => n;
};

describe('diffRedline', () => {
  it('同一の木では空配列', () => {
    const t = () => [el('p#1', [tx('#text#1', 'こんにちは')])];
    expect(diffRedline(t(), t(), createLcsBudget())).toEqual([]);
  });

  it('空白の違いだけのテキストは差分にしない', () => {
    const a = [el('p#1', [tx('#text#1', 'a  b\n')])];
    const b = [el('p#1', [tx('#text#1', 'a b')])];
    expect(diffRedline(a, b, createLcsBudget())).toEqual([]);
  });

  it('語句の削除は delText、挿入は insText として live の Text へ向ける', () => {
    const live = ref();
    const a = [el('p#1', [tx('#text#1', '受益者のみなさまへ')])];
    const b = [el('p#1', [tx('#text#1', '受益者の皆様へ', live)])];
    const ops = diffRedline(a, b, createLcsBudget());
    const del = ops.find((o) => o.kind === 'delText');
    const ins = ops.find((o) => o.kind === 'insText');
    expect(del && del.kind === 'delText' && del.node()).toBe(live());
    expect(
      del &&
        del.kind === 'delText' &&
        del.ops
          .filter((o) => o.type === 'del')
          .map((o) => o.text)
          .join(''),
    ).toBe('みなさま');
    expect(
      ins &&
        ins.kind === 'insText' &&
        ins.ops
          .filter((o) => o.type === 'ins')
          .map((o) => o.text)
          .join(''),
    ).toBe('皆様');
  });

  it('削除だけなら insText は出さず、挿入だけなら delText は出さない', () => {
    const onlyDel = diffRedline(
      [el('p#1', [tx('#text#1', 'abc def')])],
      [el('p#1', [tx('#text#1', 'abc', ref())])],
      createLcsBudget(),
    );
    expect(onlyDel.map((o) => o.kind)).toEqual(['delText']);
    const onlyIns = diffRedline(
      [el('p#1', [tx('#text#1', 'abc')])],
      [el('p#1', [tx('#text#1', 'abc def', ref())])],
      createLcsBudget(),
    );
    expect(onlyIns.map((o) => o.kind)).toEqual(['insText']);
  });

  it('live にだけある要素は addedEl、基準にだけある要素は removedEl（挿入位置つき）', () => {
    const p2 = ref();
    const p3 = ref();
    const base = [el('p#1'), el('p#2'), el('p#3')];
    const live = [el('p#1', [], ref()), el('p#3', [], p3), el('p#4', [], p2)];
    const ops = diffRedline(base, live, createLcsBudget());
    // 基準の p#2 は live に無い → 基準側で次に live にも在る兄弟 p#3 の直前へ
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.before?.()).toBe(p3());
    expect(removed && removed.kind === 'removedEl' && removed.parent).toBeNull();
    expect(removed && removed.kind === 'removedEl' && removed.inline).toBe(false);
    expect(removed && removed.kind === 'removedEl' && removed.def).toEqual({ tagName: 'p' });
    const added = ops.find((o) => o.kind === 'addedEl');
    expect(added && added.kind === 'addedEl' && added.node()).toBe(p2());
  });

  it('基準側の末尾要素が消えた場合は before が null（親の末尾へ）で、親は live の要素', () => {
    const parent = ref();
    const base = [el('div#1', [el('p#1'), el('p#2')], NIL, 'div')];
    const live = [el('div#1', [el('p#1', [], ref())], parent, 'div')];
    const ops = diffRedline(base, live, createLcsBudget());
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.before).toBeNull();
    expect(removed && removed.kind === 'removedEl' && removed.parent?.()).toBe(parent());
  });

  it('同キーで tag が違う要素は removedEl + addedEl になる', () => {
    const ops = diffRedline(
      [el('.x#1', [], NIL, 'p')],
      [el('.x#1', [], ref(), 'div')],
      createLcsBudget(),
    );
    expect(ops.map((o) => o.kind).sort()).toEqual(['addedEl', 'removedEl']);
  });

  it('基準にだけあるテキストは inline の removedEl になる', () => {
    const ops = diffRedline(
      [el('p#1', [tx('#text#1', 'a'), el('b#1'), tx('#text#2', 'tail')])],
      [el('p#1', [tx('#text#1', 'a', ref()), el('b#1', [], ref())], ref())],
      createLcsBudget(),
    );
    const removed = ops.find((o) => o.kind === 'removedEl');
    expect(removed && removed.kind === 'removedEl' && removed.inline).toBe(true);
    expect(removed && removed.kind === 'removedEl' && removed.text).toBe('tail');
  });

  it('予算を超えたテキストは全文 del + ins の粗い差分になる（取り消し線は出る）', () => {
    // `diffTokens` は共通の先頭を先に落とすので、先頭から違わせて 3001 x 3001 セルを踏ませる。
    const big = 'あ'.repeat(3000);
    const ops = diffRedline(
      [el('p#1', [tx('#text#1', `x${big}`)])],
      [el('p#1', [tx('#text#1', `y${big}`, ref())])],
      { remaining: MAX_LCS_CELLS },
    );
    const del = ops.find((o) => o.kind === 'delText');
    expect(
      del &&
        del.kind === 'delText' &&
        del.ops
          .filter((o) => o.type === 'del')
          .map((o) => o.text)
          .join(''),
    ).toBe(`x${big}`);
  });
});
