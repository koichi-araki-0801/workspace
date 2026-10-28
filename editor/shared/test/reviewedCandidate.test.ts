// =============================================================================
// reviewedCandidate.test.ts — パーツ判定を当てた最終候補と、確定を止める判定不足
// =============================================================================
// 差分(`HtmlDiff`)は手で組む。パーサに依存させず、判定の当て方だけを固定するため。

import { describe, expect, it } from 'vitest';
import type { DiffBlock, DiffPage, HtmlDiff } from '../src/html/reviewDiff/htmlDiff';
import {
  buildReviewedHtmlCandidate,
  reviewedPageOrder,
} from '../src/html/reviewDiff/reviewedCandidate';
import type { CreateReviewPartDecision } from '../src/html/reviewParts';

const BREAK = '\n<div class="pagebreak"></div>\n';

function block(
  key: string,
  status: DiffBlock['status'],
  rawBeforeHtml: string,
  rawAfterHtml: string,
): DiffBlock {
  return {
    key,
    partKey: key,
    beforePartKey: key,
    status,
    beforeHtml: rawBeforeHtml,
    afterHtml: rawAfterHtml,
    rawBeforeHtml,
    rawAfterHtml,
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

function diffOf(pages: DiffPage[], beforePageCount: number, afterPageCount: number): HtmlDiff {
  return {
    pages,
    changedPageCount: pages.filter((p) => p.changed).length,
    beforePageCount,
    afterPageCount,
    coarse: false,
    truncated: false,
  };
}

const decided = (
  partKey: string,
  status: CreateReviewPartDecision['status'],
): CreateReviewPartDecision => ({ partKey, status });

describe('buildReviewedHtmlCandidate', () => {
  const changed = diffOf(
    [
      page(
        0,
        [
          block('p#1', 'same', '<p>a</p>', '<p>a</p>'),
          block('h1#1', 'changed', '<h1>旧</h1>', '<h1>新</h1>'),
        ],
        ['p#1', 'h1#1'],
        ['p#1', 'h1#1'],
      ),
    ],
    1,
    1,
  );

  it('承認した変更は申請版、却下した変更は現行版を候補にする', () => {
    expect(buildReviewedHtmlCandidate(changed, [decided('h1#1', 'approved')]).html).toBe(
      '<p>a</p>\n<h1>新</h1>',
    );
    expect(buildReviewedHtmlCandidate(changed, [decided('h1#1', 'rejected')]).html).toBe(
      '<p>a</p>\n<h1>旧</h1>',
    );
  });

  it('保存済みの pending は未判定に数え、候補には現行版を置く', () => {
    const res = buildReviewedHtmlCandidate(changed, [decided('h1#1', 'pending')]);
    expect(res.pendingPartKeys).toEqual(['h1#1']);
    expect(res.html).toBe('<p>a</p>\n<h1>旧</h1>');
  });

  it('同じパーツの判定が複数あれば重複として返す', () => {
    const res = buildReviewedHtmlCandidate(changed, [
      decided('h1#1', 'approved'),
      decided('h1#1', 'rejected'),
    ]);
    expect(res.duplicateDecisionPartKeys).toEqual(['h1#1']);
    expect(buildReviewedHtmlCandidate(changed, [decided('h1#1', 'approved')])).toMatchObject({
      duplicateDecisionPartKeys: [],
      pendingPartKeys: [],
      unknownDecisionPartKeys: [],
    });
  });

  it('ページを移ったパーツ(前のページで削除・次のページで追加)の未判定は 1 回だけ返す', () => {
    const moved = (status: DiffBlock['status'], before: string, after: string) => ({
      ...block('m#1', status, before, after),
      partKey: 'x#1',
    });
    const diff = diffOf(
      [
        page(0, [moved('removed', '<p id="x">X</p>', '')], ['m#1'], []),
        page(1, [moved('added', '', '<p id="x">X</p>')], [], ['m#1']),
      ],
      2,
      2,
    );
    expect(buildReviewedHtmlCandidate(diff, []).pendingPartKeys).toEqual(['x#1']);
  });

  it('本文に無い判定を返す', () => {
    const res = buildReviewedHtmlCandidate(changed, [
      decided('h1#1', 'approved'),
      decided('gone#1', 'approved'),
    ]);
    expect(res.unknownDecisionPartKeys).toEqual(['gone#1']);
  });

  it('中身が空になったページも区切りを残す(申請版にあるページの数を保つ)', () => {
    const diff = diffOf(
      [
        page(0, [block('p#1', 'same', '<p>a</p>', '<p>a</p>')], ['p#1'], ['p#1']),
        page(1, [block('p#2', 'added', '', '<p>new</p>')], [], ['p#2']),
        page(2, [block('p#3', 'same', '<p>c</p>', '<p>c</p>')], ['p#3'], ['p#3']),
      ],
      2,
      3,
    );
    const res = buildReviewedHtmlCandidate(diff, [decided('p#2', 'rejected')]);
    expect(res.html).toBe(`<p>a</p>${BREAK}${BREAK}<p>c</p>`);
  });

  it('申請版に無いページは中身が残るときだけ区切りを足す', () => {
    const diff = diffOf(
      [
        page(0, [block('p#1', 'same', '<p>a</p>', '<p>a</p>')], ['p#1'], ['p#1']),
        page(1, [block('p#2', 'removed', '<p>b</p>', '')], ['p#2'], []),
        page(2, [block('p#3', 'removed', '<p>c</p>', '')], ['p#3'], []),
      ],
      3,
      1,
    );
    expect(
      buildReviewedHtmlCandidate(diff, [decided('p#2', 'approved'), decided('p#3', 'rejected')])
        .html,
    ).toBe(`<p>a</p>${BREAK}<p>c</p>`);
    expect(
      buildReviewedHtmlCandidate(diff, [decided('p#2', 'approved'), decided('p#3', 'approved')])
        .html,
    ).toBe('<p>a</p>');
  });
});

describe('reviewedPageOrder', () => {
  it('却下した削除は比較元の直前のパーツの後ろ、無ければ直後のパーツの前へ戻す', () => {
    const selected = new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ]);
    expect(reviewedPageOrder(['a', 'b', 'c'], ['a', 'c'], selected)).toEqual(['a', 'b', 'c']);
    expect(reviewedPageOrder(['b', 'a'], ['a'], selected)).toEqual(['b', 'a']);
    expect(reviewedPageOrder(['b'], [], selected)).toEqual(['b']);
  });
});
