// =============================================================================
// reviewDecisionList.dom.test.ts — 承認タブ右欄「変更と判定」の一覧と表示窓
// =============================================================================
// jsdom は IntersectionObserver もレイアウトも持たないので、IO はスタブで番兵の出入りを起こす。
// スクロール補正の量そのものは `reviewDecisionListModel.test.ts` の純関数で検査し、ここでは窓の
// 開始・終了・上限の振る舞いと、補正が scrollTop へ届く配線だけを見る(位置の実測は e2e)。
import type { ReviewPartDecision } from '@editor/shared';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ReviewDecisionList from '@/features/reviews/ReviewDecisionList.vue';
import type { ReviewChangeRow } from '@/features/reviews/services/reviewDiffService';

// ── 1. IntersectionObserver のスタブ ──

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed = new Set<Element>();
  constructor(readonly cb: IntersectionObserverCallback) {
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  fire(el: Element) {
    this.cb(
      [{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const observedAll = () => FakeIO.instances.flatMap((io) => [...io.observed]);

async function see(w: VueWrapper, sel: string) {
  const el = w.find(sel).element;
  const io = FakeIO.instances.find((i) => i.observed.has(el));
  expect(io, `${sel} が観測されていない`).toBeDefined();
  io?.fire(el);
  await flush();
}

async function flush() {
  for (let i = 0; i < 4; i++) await nextTick();
}

beforeEach(() => {
  FakeIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 2. 材料 ──

function change(no: number, over: Partial<ReviewChangeRow> = {}): ReviewChangeRow {
  return {
    no,
    partKey: `p#${no}`,
    beforePartKey: `p#${no}`,
    kind: 'changed',
    beforePage: 0,
    afterPage: 0,
    beforeHtml: '',
    afterHtml: '',
    rawBeforeHtml: '',
    rawAfterHtml: '',
    label: `ページ1・パーツ${no}`,
    coarse: false,
    name: `パーツ名${no}`,
    textOps: [
      { type: 'same', text: '基準価額 ' },
      { type: 'del', text: '<b>旧</b>' },
      { type: 'ins', text: '新' },
    ],
    ...over,
  };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => change(i + 1));

const decided = (
  no: number,
  status: 'approved' | 'rejected',
  comment: string | null = null,
): ReviewPartDecision =>
  ({
    partKey: `p#${no}`,
    status,
    decidedBy: 'u',
    decidedAt: '2026-10-29T00:00:00Z',
    comment,
    history: [],
  }) as ReviewPartDecision;

function mountList(props: Partial<InstanceType<typeof ReviewDecisionList>['$props']> = {}) {
  return mount(ReviewDecisionList, {
    props: {
      changes: many(3),
      decisions: [],
      selectedNo: null,
      canDecide: true,
      busy: false,
      ...props,
    },
    attachTo: document.body,
  });
}

const rowNos = (w: VueWrapper) =>
  w.findAll('[data-review-row-no]').map((r) => Number(r.attributes('data-review-row-no')));

const row = (w: VueWrapper, no: number) => w.find(`[data-review-row-no="${no}"]`);

const button = (root: { findAll: VueWrapper['findAll'] }, text: string) => {
  const b = root.findAll('button').find((x) => x.text() === text);
  if (!b) throw new Error(`ボタン「${text}」が無い`);
  return b;
};

// ── 3. 行の表示と操作 ──

describe('ReviewDecisionList — 行と判定', () => {
  it('行は番号順に並び、番号・名前・種別・文字の差分を出す', () => {
    const w = mountList({
      changes: [change(3, { kind: 'removed' }), change(1, { kind: 'added' }), change(2)],
    });
    expect(rowNos(w)).toEqual([1, 2, 3]);
    const r1 = row(w, 1);
    expect(r1.find('[data-review-no]').text()).toBe('1');
    const nm = r1.find('[data-review-name]');
    expect(nm.text()).toBe('パーツ名1');
    expect(nm.attributes('title')).toBe('ページ1・パーツ1');
    expect(r1.find('[data-review-kind]').text()).toBe('追加');
    expect(row(w, 2).find('[data-review-kind]').text()).toBe('変更');
    expect(row(w, 3).find('[data-review-kind]').text()).toBe('削除');
    // 文字の差分は親の DOM にエスケープして描く(タグとして解釈しない)
    const del = r1.find('del');
    expect(del.text()).toBe('<b>旧</b>');
    expect(del.find('b').exists()).toBe(false);
    expect(r1.find('ins').text()).toBe('新');
    // 説明は 1 回だけ
    const desc =
      '文字の変更は、申請者のスタイルに影響されない本文の照合です。確定・保存されるのはこの差分です。';
    expect(w.text().split(desc)).toHaveLength(2);
  });

  it('変わらない部分の連続する空白は 1 つに詰め、足した・消した部分の空白は残す', () => {
    const w = mountList({
      changes: [
        change(1, {
          textOps: [
            { type: 'same', text: 'a\n      b' },
            { type: 'ins', text: '\n    ' },
            { type: 'del', text: 'x  \n y' },
          ],
        }),
      ],
    });
    const r = row(w, 1);
    expect(r.find('p span').element.textContent).toBe('a b');
    expect(r.find('ins').element.textContent).toBe('\n    ');
    expect(r.find('del').element.textContent).toBe('x  \n y');
  });

  it('変わらない部分の全角空白(U+3000)・NBSP は詰めずに残す(本文の字下げは意味のある字)', () => {
    const [ideo, nbsp] = [String.fromCharCode(0x3000), String.fromCharCode(0xa0)];
    const text = `${ideo}${ideo}字下げ${nbsp}${nbsp}の段落   末尾`;
    const w = mountList({ changes: [change(1, { textOps: [{ type: 'same', text }] })] });
    expect(row(w, 1).find('p span').element.textContent).toBe(
      `${ideo}${ideo}字下げ${nbsp}${nbsp}の段落 末尾`,
    );
  });

  it('粗い差分の行には注記を出す', () => {
    const w = mountList({ changes: [change(1, { coarse: true }), change(2)] });
    expect(row(w, 1).text()).toContain(
      'この箇所は変更が大きいため、変わった文字の色付けはせず全文を並べています',
    );
    expect(row(w, 2).text()).not.toContain('この箇所は変更が大きいため');
  });

  it('番号の色は判定で変わる', () => {
    const w = mountList({ decisions: [decided(1, 'approved'), decided(2, 'rejected', 'x')] });
    expect(row(w, 1).find('[data-review-no]').attributes('data-decision')).toBe('approved');
    expect(row(w, 2).find('[data-review-no]').attributes('data-decision')).toBe('rejected');
    expect(row(w, 3).find('[data-review-no]').attributes('data-decision')).toBe('pending');
  });

  it('承認は 1 行の partKey で approve を emit する', async () => {
    const w = mountList();
    await button(row(w, 2), '承認').trigger('click');
    expect(w.emitted('approve')).toEqual([[['p#2']]]);
  });

  it('却下…で理由欄を開き、空のまま「却下する」は emit せず「理由を入力してください。」を出す', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    const r = row(w, 1);
    expect(r.text()).toContain('却下の理由（このパーツ・必須）');
    const ta = r.find('textarea');
    expect(ta.attributes('placeholder')).toBe('申請者が直せるように理由を書きます');
    expect(r.text()).toContain('理由は申請者の編集画面に表示します。');
    await button(r, '却下する').trigger('click');
    expect(w.emitted('reject')).toBeUndefined();
    expect(row(w, 1).text()).toContain('理由を入力してください。');
    await ta.setValue('  数値が違う  ');
    await button(row(w, 1), '却下する').trigger('click');
    expect(w.emitted('reject')).toEqual([[['p#1'], '数値が違う']]);
  });

  it('却下の理由は 2000 単位を超えると送れない', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    await row(w, 1).find('textarea').setValue('あ'.repeat(2001));
    const send = button(row(w, 1), '却下する');
    expect(send.attributes('disabled')).toBeDefined();
    await send.trigger('click');
    expect(w.emitted('reject')).toBeUndefined();
    await row(w, 1).find('textarea').setValue('あ'.repeat(2000));
    await button(row(w, 1), '却下する').trigger('click');
    expect(w.emitted('reject')).toHaveLength(1);
  });

  it('行の却下の「いま N 文字」は前後の空白を除いて数える(送る形と同じ)', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    await row(w, 1)
      .find('textarea')
      .setValue(`  ${'あ'.repeat(2001)}\n`);
    expect(row(w, 1).text()).toContain('理由は 2000 文字までです（いま 2001 文字）。');
  });

  it('行の却下の理由欄は、出ている注意と説明を aria-describedby で指す', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    const ta = () => row(w, 1).find('textarea');
    const described = () =>
      (ta().attributes('aria-describedby') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => w.find(`[id="${id}"]`).text());
    expect(described()).toEqual(['理由は申請者の編集画面に表示します。']);
    await button(row(w, 1), '却下する').trigger('click');
    expect(described()).toEqual([
      '理由を入力してください。',
      '理由は申請者の編集画面に表示します。',
    ]);
    await ta().setValue('あ'.repeat(2001));
    expect(described()).toEqual([
      '理由は 2000 文字までです（いま 2001 文字）。',
      '理由は申請者の編集画面に表示します。',
    ]);
  });

  it('理由欄の「取消」で閉じる', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    await button(row(w, 1), '取消').trigger('click');
    expect(row(w, 1).find('textarea').exists()).toBe(false);
  });

  it('判定済みの行は「判定を取り消す」で undo を emit する', async () => {
    const w = mountList({ decisions: [decided(1, 'approved'), decided(2, 'rejected', '誤字')] });
    expect(row(w, 1).text()).toContain('承認済み');
    expect(row(w, 2).text()).toContain('却下済み');
    expect(row(w, 2).text()).toContain('理由: 誤字');
    expect(row(w, 1).find('input[type="checkbox"]').exists()).toBe(false);
    await button(row(w, 2), '判定を取り消す').trigger('click');
    expect(w.emitted('undo')).toEqual([['p#2']]);
  });

  it('行を押すと select を emit し、チェック・ボタン・理由欄の押下では emit しない', async () => {
    const w = mountList();
    await row(w, 2).trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
    await row(w, 1).find('input[type="checkbox"]').trigger('click');
    await button(row(w, 1), '承認').trigger('click');
    await button(row(w, 1), '却下…').trigger('click');
    await row(w, 1).find('textarea').trigger('click');
    await button(row(w, 1), '取消').trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
  });

  it('名前はボタンで、押すと select を 1 回 emit する(キーボードでも選べる)', async () => {
    const w = mountList();
    const nm = row(w, 2).find('[data-review-name]');
    expect(nm.element.tagName).toBe('BUTTON');
    expect(nm.attributes('type')).toBe('button');
    await nm.trigger('click');
    expect(w.emitted('select')).toEqual([[2]]);
  });

  it('保存中(busy)は判定のボタンを押せない', async () => {
    const w = mountList({ busy: true, decisions: [decided(3, 'approved')] });
    expect(button(row(w, 1), '承認').attributes('disabled')).toBeDefined();
    expect(button(row(w, 1), '却下…').attributes('disabled')).toBeDefined();
    expect(button(row(w, 3), '判定を取り消す').attributes('disabled')).toBeDefined();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    expect(button(w, 'まとめて承認').attributes('disabled')).toBeDefined();
    expect(button(w, 'まとめて却下…').attributes('disabled')).toBeDefined();
  });

  it('判定が届いたら理由欄を閉じる(失敗で届かなければ開いたまま)', async () => {
    const w = mountList();
    await button(row(w, 1), '却下…').trigger('click');
    await row(w, 1).find('textarea').setValue('理由');
    await button(row(w, 1), '却下する').trigger('click');
    expect(row(w, 1).find('textarea').exists()).toBe(true);
    await w.setProps({ decisions: [decided(1, 'rejected', '理由')] });
    expect(row(w, 1).find('textarea').exists()).toBe(false);
  });

  it('canDecide=false では操作を出さず、却下の理由を読み取り専用で出す', () => {
    const w = mountList({
      canDecide: false,
      decisions: [decided(1, 'approved'), decided(2, 'rejected', '表が古い')],
    });
    // 名前のボタン(行の選択)だけが残る
    expect(w.findAll('button:not([data-review-name])')).toHaveLength(0);
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.find('textarea').exists()).toBe(false);
    expect(w.text()).not.toContain('まとめて承認');
    expect(row(w, 1).text()).toContain('承認済み');
    expect(row(w, 2).text()).toContain('理由: 表が古い');
    expect(row(w, 3).text()).toContain('未判定');
    expect(row(w, 3).text()).not.toContain('承認待ち');
  });
});

// ── 4. まとめて判定 ──

describe('ReviewDecisionList — まとめて判定', () => {
  it('チェックした数を「N 件選択中」で出し、まとめて承認は確認なしで 1 回 emit する', async () => {
    const w = mountList();
    expect(w.text()).toContain('0 件選択中');
    expect(button(w, 'まとめて承認').attributes('disabled')).toBeDefined();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    await row(w, 3).find('input[type="checkbox"]').setValue(true);
    expect(w.text()).toContain('2 件選択中');
    await button(w, 'まとめて承認').trigger('click');
    expect(w.emitted('approve')).toEqual([[['p#1', 'p#3']]]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('まとめて却下は選んだ全パーツと同じ理由で reject を 1 回 emit する', async () => {
    const w = mountList();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    await row(w, 2).find('input[type="checkbox"]').setValue(true);
    await button(w, 'まとめて却下…').trigger('click');
    const box = w.find('[data-review-bulk-reject]');
    expect(box.text()).toContain('選んだパーツを却下する理由（必須）');
    expect(box.find('textarea').attributes('placeholder')).toBe(
      '同じ理由を、選んだパーツそれぞれの却下理由として保存します',
    );
    expect(box.text()).toContain(
      '理由はパーツごとに 1 件ずつ保存し、申請者の編集画面に表示します。',
    );
    expect(w.text()).not.toContain('コメントとしても投稿');
    await button(box, '2 件を却下する').trigger('click');
    expect(w.emitted('reject')).toBeUndefined();
    expect(w.find('[data-review-bulk-reject]').text()).toContain('理由を入力してください。');
    await box.find('textarea').setValue('全体に古い');
    await button(w.find('[data-review-bulk-reject]'), '2 件を却下する').trigger('click');
    expect(w.emitted('reject')).toEqual([[['p#1', 'p#2'], '全体に古い']]);
  });

  it('チェックを外すと選択から外れる', async () => {
    const w = mountList();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    expect(w.text()).toContain('1 件選択中');
    await row(w, 1).find('input[type="checkbox"]').setValue(false);
    expect(w.text()).toContain('0 件選択中');
  });

  it('まとめて却下の理由は空白だけでは送れず、2000 単位を超えても送れない', async () => {
    const w = mountList();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    await button(w, 'まとめて却下…').trigger('click');
    const box = () => w.find('[data-review-bulk-reject]');
    await button(box(), '1 件を却下する').trigger('click');
    expect(box().text()).toContain('理由を入力してください。');
    // 空白だけを入れても、空の注意は消えない(理由を書いたことにならない)。
    await box().find('textarea').setValue('   ');
    expect(box().text()).toContain('理由を入力してください。');
    await box().find('textarea').setValue('あ'.repeat(2001));
    expect(box().text()).toContain('理由は 2000 文字までです（いま 2001 文字）。');
    await button(box(), '1 件を却下する').trigger('click');
    expect(w.emitted('reject')).toBeUndefined();
  });

  it('まとめて却下の理由欄は、出ている注意と説明を aria-describedby で指し、字数は前後の空白を除く', async () => {
    const w = mountList();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    await button(w, 'まとめて却下…').trigger('click');
    const box = () => w.find('[data-review-bulk-reject]');
    const described = () =>
      (box().find('textarea').attributes('aria-describedby') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => w.find(`[id="${id}"]`).text());
    const note = '理由はパーツごとに 1 件ずつ保存し、申請者の編集画面に表示します。';
    expect(described()).toEqual([note]);
    await button(box(), '1 件を却下する').trigger('click');
    expect(described()).toEqual(['理由を入力してください。', note]);
    await box()
      .find('textarea')
      .setValue(` ${'あ'.repeat(2001)} `);
    expect(described()).toEqual(['理由は 2000 文字までです（いま 2001 文字）。', note]);
  });

  it('まとめて却下の「取消」で欄を閉じる', async () => {
    const w = mountList();
    await row(w, 1).find('input[type="checkbox"]').setValue(true);
    await button(w, 'まとめて却下…').trigger('click');
    await button(w.find('[data-review-bulk-reject]'), '取消').trigger('click');
    expect(w.find('[data-review-bulk-reject]').exists()).toBe(false);
  });

  it('未判定をすべて選ぶは判定済みを選ばない', async () => {
    const w = mountList({ changes: many(4), decisions: [decided(2, 'approved')] });
    await w.find('[data-review-pick-all]').setValue(true);
    expect(w.text()).toContain('3 件選択中');
    await button(w, 'まとめて承認').trigger('click');
    expect(w.emitted('approve')).toEqual([[['p#1', 'p#3', 'p#4']]]);
    await w.find('[data-review-pick-all]').setValue(false);
    expect(w.text()).toContain('0 件選択中');
  });

  it('判定が届いたパーツは選択から外れる', async () => {
    const w = mountList();
    await w.find('[data-review-pick-all]').setValue(true);
    expect(w.text()).toContain('3 件選択中');
    await w.setProps({ decisions: [decided(1, 'approved')] });
    expect(w.text()).toContain('2 件選択中');
  });

  it('未判定が無ければ「未判定をすべて選ぶ」は押せない', () => {
    const w = mountList({ changes: many(1), decisions: [decided(1, 'approved')] });
    expect(w.find('[data-review-pick-all]').attributes('disabled')).toBeDefined();
  });
});

// ── 5. 表示窓 ──

describe('ReviewDecisionList — 表示窓', () => {
  it('初めは先頭の 50 行を描き、下の番兵が見えたら次の 50 行を足す', async () => {
    const w = mountList({ changes: many(300) });
    await flush();
    expect(rowNos(w)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    await see(w, '[data-review-sentinel="bottom"]');
    expect(rowNos(w)).toHaveLength(100);
    expect(rowNos(w).at(-1)).toBe(100);
    const bottom = w.find('[data-review-sentinel="bottom"]').element as HTMLElement;
    expect(bottom.style.height).toBe(`${200 * 96}px`);
  });

  it('描く行は 150 行を超えず、超えたら上から外して上の余白に回す', async () => {
    const w = mountList({ changes: many(300) });
    await flush();
    await see(w, '[data-review-sentinel="bottom"]');
    await see(w, '[data-review-sentinel="bottom"]');
    expect(rowNos(w)).toHaveLength(150);
    await see(w, '[data-review-sentinel="bottom"]');
    const nos = rowNos(w);
    expect(nos).toHaveLength(150);
    expect(nos[0]).toBe(51);
    expect(nos.at(-1)).toBe(200);
    const top = w.find('[data-review-sentinel="top"]').element as HTMLElement;
    expect(top.style.height).toBe(`${50 * 96}px`);
  });

  it('境界: 150 件はすべて描いて上から外さず、151 件は最後の 1 行を足すときに先頭の 1 行を外す', async () => {
    const bottomSel = '[data-review-sentinel="bottom"]';
    const topSel = '[data-review-sentinel="top"]';
    const w150 = mountList({ changes: many(150) });
    await flush();
    await see(w150, bottomSel);
    await see(w150, bottomSel);
    expect(rowNos(w150)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(observedAll()).not.toContain(w150.find(bottomSel).element);
    expect(observedAll()).not.toContain(w150.find(topSel).element);
    w150.unmount();

    FakeIO.instances = [];
    const w151 = mountList({ changes: many(151) });
    await flush();
    await see(w151, bottomSel);
    await see(w151, bottomSel);
    expect(rowNos(w151)).toHaveLength(150);
    expect(rowNos(w151).at(-1)).toBe(150);
    await see(w151, bottomSel);
    expect(rowNos(w151)).toEqual(Array.from({ length: 150 }, (_, i) => i + 2));
    expect((w151.find(topSel).element as HTMLElement).style.height).toBe('96px');
    expect(observedAll()).toContain(w151.find(topSel).element);
    expect(observedAll()).not.toContain(w151.find(bottomSel).element);
  });

  it('下へ広げて上から外したとき、外した行の実高と見込み高の差だけ scrollTop を戻す', async () => {
    const w = mountList({ changes: many(300) });
    await flush();
    await see(w, '[data-review-sentinel="bottom"]');
    await see(w, '[data-review-sentinel="bottom"]');
    // 行の実高を 120.5px とする。端数を落とす `offsetHeight`(120 を返す)では測らない —
    // 実ブラウザで 50 行 × 0.5px = 25px ずれた(Task 14 の e2e)。
    for (const r of w.findAll('[data-review-row-no]')) {
      Object.defineProperty(r.element, 'offsetHeight', { value: 120, configurable: true });
      r.element.getBoundingClientRect = () => ({ height: 120.5 }) as DOMRect;
    }
    const scroller = w.find('[data-review-scroller]').element as HTMLElement;
    scroller.scrollTop = 10000;
    await see(w, '[data-review-sentinel="bottom"]');
    expect(scroller.scrollTop).toBe(10000 - 50 * (120.5 - 96));
  });

  it('上の番兵が見えたら上へ 50 行戻し、下から外し、足した行の差だけ scrollTop を足す', async () => {
    const w = mountList({ changes: many(300) });
    await flush();
    for (let i = 0; i < 3; i++) await see(w, '[data-review-sentinel="bottom"]');
    expect(rowNos(w)[0]).toBe(51);
    const scroller = w.find('[data-review-scroller]').element as HTMLElement;
    scroller.scrollTop = 5000;
    // 足される行(1〜50)の実高を 92.5px にする — 描かれた直後に測るので prototype で与える。
    // `offsetHeight` は端数を落とした 92 を返すようにして、そちらで測っていないことも見る。
    const ohSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(92);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return { height: this.hasAttribute('data-review-row-no') ? 92.5 : 0 } as DOMRect;
    });
    await see(w, '[data-review-sentinel="top"]');
    spy.mockRestore();
    ohSpy.mockRestore();
    const nos = rowNos(w);
    expect(nos[0]).toBe(1);
    expect(nos.at(-1)).toBe(150);
    expect(scroller.scrollTop).toBe(5000 + 50 * (92.5 - 96));
  });

  it('start が 0 のときは上の番兵を観測しない', async () => {
    const w = mountList({ changes: many(300) });
    await flush();
    const top = w.find('[data-review-sentinel="top"]').element;
    const bottom = w.find('[data-review-sentinel="bottom"]').element;
    expect(observedAll()).toContain(bottom);
    expect(observedAll()).not.toContain(top);
    for (let i = 0; i < 3; i++) await see(w, '[data-review-sentinel="bottom"]');
    expect(observedAll()).toContain(top);
  });

  it('末尾まで描いたら下の番兵を観測しない', async () => {
    const w = mountList({ changes: many(60) });
    await flush();
    await see(w, '[data-review-sentinel="bottom"]');
    expect(rowNos(w)).toHaveLength(60);
    expect(observedAll()).not.toContain(w.find('[data-review-sentinel="bottom"]').element);
  });

  it('窓の外の行を revealNo すると、途中を描かずに窓を [no-50, no+50) へ移す', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    (w.vm as unknown as { revealNo(no: number): void }).revealNo(800);
    await flush();
    const nos = rowNos(w);
    expect(nos[0]).toBe(750);
    expect(nos.at(-1)).toBe(849);
    expect(nos).toHaveLength(100);
    expect(row(w, 800).element.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('revealNo を続けて呼ぶと、最後の呼び出しの行だけへ送る(前の呼び出しが後から送らない)', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    const vm = w.vm as unknown as { revealNo(no: number): Promise<void> };
    const first = vm.revealNo(800);
    const second = vm.revealNo(20);
    await Promise.all([first, second]);
    await flush();
    expect(rowNos(w)[0]).toBe(1);
    const calls = vi.mocked(Element.prototype.scrollIntoView).mock.contexts as Element[];
    expect(calls.map((el) => el.getAttribute('data-review-row-no'))).toEqual(['20']);
    // 送り終えたら、番兵の通知をまた受ける(続けて呼んでも受けないままにならない)。
    await see(w, '[data-review-sentinel="bottom"]');
    expect(rowNos(w).at(-1)).toBe(119);
  });

  it('revealNo の送りの最中に番兵の通知が来ても窓を動かさず、送ったあとに観測し直す', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    const vm = w.vm as unknown as { revealNo(no: number): Promise<void> };
    const bottom = w.find('[data-review-sentinel="bottom"]').element;
    const io = FakeIO.instances[0];
    if (!io) throw new Error('IO が無い');
    const done = vm.revealNo(800);
    // 送り(nextTick を待つ間)の最中に届いた通知。ここで窓を広げると、送ったあとに scrollTop の
    // 補正が後から走り、送った行が見える位置からずれる。
    io.fire(bottom);
    await done;
    await flush();
    expect(rowNos(w)[0]).toBe(750);
    expect(rowNos(w).at(-1)).toBe(849);
    expect(row(w, 800).element.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    // 受けなかった通知の代わりに、送ったあとに番兵を観測し直す(まだ見えていれば IO が改めて通知する)。
    expect(io.observed.has(bottom)).toBe(true);
  });

  it('知らない番号の revealNo は何もしない', async () => {
    const w = mountList({ changes: many(10) });
    await flush();
    await (w.vm as unknown as { revealNo(no: number): Promise<void> }).revealNo(999);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('帯の無い読み取り専用(canDecide=false)でも revealNo は余白 0 で送る', async () => {
    const w = mountList({ changes: many(10), canDecide: false });
    await flush();
    expect(w.find('[data-review-band]').exists()).toBe(false);
    await (w.vm as unknown as { revealNo(no: number): Promise<void> }).revealNo(5);
    expect((row(w, 5).element as HTMLElement).style.scrollMarginTop).toBe('0px');
  });

  it('番兵の通知が見えていない・番兵以外・それ以上広げられないときは窓を動かさない', async () => {
    const w = mountList({ changes: many(60) });
    await flush();
    const io = FakeIO.instances[0];
    if (!io) throw new Error('IO が無い');
    const notify = (target: Element, isIntersecting: boolean) =>
      io.cb(
        [{ target, isIntersecting } as unknown as IntersectionObserverEntry],
        io as unknown as IntersectionObserver,
      );
    const top = w.find('[data-review-sentinel="top"]').element;
    const bottom = w.find('[data-review-sentinel="bottom"]').element;
    notify(bottom, false);
    notify(document.body, true);
    // 先頭まで描いているので、上の番兵が見えても上へは広げない。
    notify(top, true);
    await flush();
    expect(rowNos(w)).toHaveLength(50);
    // 末尾まで広げたあとに下の番兵の通知が来ても、それ以上は足さない。
    notify(bottom, true);
    await flush();
    expect(rowNos(w)).toHaveLength(60);
    notify(bottom, true);
    await flush();
    expect(rowNos(w)).toHaveLength(60);
  });

  it('窓の中の行を revealNo すると、窓を動かさずに送る', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    (w.vm as unknown as { revealNo(no: number): void }).revealNo(20);
    await flush();
    expect(rowNos(w)[0]).toBe(1);
    expect(rowNos(w)).toHaveLength(50);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('選ばれた行は窓を移しても選ばれたまま', async () => {
    const w = mountList({ changes: many(1000), selectedNo: 3 });
    await flush();
    await row(w, 3).find('input[type="checkbox"]').setValue(true);
    const vm = w.vm as unknown as { revealNo(no: number): void };
    vm.revealNo(800);
    await flush();
    expect(row(w, 3).exists()).toBe(false);
    expect(w.text()).toContain('1 件選択中');
    vm.revealNo(3);
    await flush();
    expect(row(w, 3).attributes('data-selected')).toBe('true');
    expect((row(w, 3).find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(
      true,
    );
    await button(w, 'まとめて承認').trigger('click');
    expect(w.emitted('approve')).toEqual([[['p#3']]]);
  });

  it('スクロール容器はブラウザのスクロールアンカリングを切る(手での補正と二重にしない)', () => {
    const w = mountList();
    expect(w.find('[data-review-scroller]').classes()).toContain('[overflow-anchor:none]');
  });

  it('revealNo は送る行の上に帯の高さぶんの余白を取る(sticky の帯の下へ隠さない)', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    Object.defineProperty(w.find('[data-review-band]').element, 'offsetHeight', {
      value: 57,
      configurable: true,
    });
    (w.vm as unknown as { revealNo(no: number): void }).revealNo(800);
    await flush();
    expect((row(w, 800).element as HTMLElement).style.scrollMarginTop).toBe('57px');
  });

  it('書きかけの却下理由は、行が窓から外れて戻っても残る', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    await button(row(w, 3), '却下…').trigger('click');
    await row(w, 3).find('textarea').setValue('書きかけ');
    const vm = w.vm as unknown as { revealNo(no: number): void };
    vm.revealNo(800);
    await flush();
    expect(row(w, 3).exists()).toBe(false);
    vm.revealNo(3);
    await flush();
    const ta = row(w, 3).find('textarea');
    expect(ta.exists()).toBe(true);
    expect((ta.element as HTMLTextAreaElement).value).toBe('書きかけ');
    // 窓の外で判定が届いたら書きかけは捨てる
    vm.revealNo(800);
    await flush();
    await w.setProps({ decisions: [decided(3, 'rejected', '書きかけ')] });
    await w.setProps({ decisions: [] });
    vm.revealNo(3);
    await flush();
    expect(row(w, 3).find('textarea').exists()).toBe(false);
  });

  it('変更の件数が減ったら窓を全件に収める', async () => {
    const w = mountList({ changes: many(1000) });
    await flush();
    (w.vm as unknown as { revealNo(no: number): void }).revealNo(800);
    await flush();
    await w.setProps({ changes: many(10) });
    await flush();
    expect(rowNos(w)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });
});
