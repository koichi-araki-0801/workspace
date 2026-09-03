import type { PartNoteEntry } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { resolveConfirm } from '@/components/ui/confirm';
import CommentPanel from '@/features/editor/comments/CommentPanel.vue';

const COVER = '.page#1/cover#1';
const SUMMARY = '.page#1/.summary#1';

function entry(p: Partial<PartNoteEntry> & { id: string }): PartNoteEntry {
  return {
    templateId: 'AM01_510037_20240710_交付版',
    pathKey: COVER,
    content: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: '山田',
    updatedAt: null,
    updatedBy: null,
    status: 'open',
    replyTo: null,
    kind: 'note',
    ...p,
  };
}

const partLabels = new Map([
  [COVER, 'ページ1・パーツ1'],
  [SUMMARY, 'ページ1・パーツ2'],
]);

const entries = [
  entry({
    id: 'a',
    content: '表紙の日付を直してください',
    kind: 'fix-request',
    createdAt: '2026-09-01T00:00:01.000Z',
  }),
  entry({
    id: 'a-r',
    replyTo: 'a',
    content: '直しました',
    createdBy: '鈴木',
    createdAt: '2026-09-01T00:00:02.000Z',
  }),
  entry({
    id: 'b',
    content: '要約の数値は確定ですか',
    pathKey: SUMMARY,
    kind: 'question',
    status: 'resolved',
    createdAt: '2026-09-01T00:00:03.000Z',
  }),
];

function mountPanel(extra: Record<string, unknown> = {}) {
  return mount(CommentPanel, {
    props: { entries, selectedKey: COVER, canAdd: true, partLabels, ...extra },
  });
}

describe('CommentPanel', () => {
  it('既定は未対応の親投稿だけを行として出し、返信数とパーツ名を添える', () => {
    const w = mountPanel();
    const rows = w.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('表紙の日付');
    expect(rows[0].text()).toContain('ページ1・パーツ1');
    expect(rows[0].text()).toContain('返信 1');
  });

  it('状態の絞り込みを「すべて」にすると解決済みも出る', async () => {
    const w = mountPanel();
    await w.find('[data-filter-status]').setValue('all');
    expect(w.findAll('[data-comment-row]')).toHaveLength(2);
  });

  it('検索欄は本文で絞り込む', async () => {
    const w = mountPanel();
    await w.find('[data-filter-status]').setValue('all');
    await w.find('input[type="search"]').setValue('数値');
    const rows = w.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('要約');
  });

  it('行のクリックで focus(pathKey) を emit する', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row]').trigger('click');
    expect(w.emitted('focus')?.[0]).toEqual([COVER]);
  });

  it('新規入力は選択パーツ宛に種別付きで add を emit し、入力を空へ戻す', async () => {
    const w = mountPanel();
    await w.find('[data-add-kind]').setValue('question');
    const ta = w.find('textarea[data-add-content]');
    await ta.setValue('これは確定値ですか');
    await w.find('button[data-add-submit]').trigger('click');
    expect(w.emitted('add')?.[0]).toEqual(['これは確定値ですか', 'question']);
    expect((ta.element as HTMLTextAreaElement).value).toBe('');
  });

  it('canAdd が false なら入力欄は無効', () => {
    const w = mountPanel({ canAdd: false, selectedKey: null });
    expect((w.find('textarea[data-add-content]').element as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });

  it('行を開くと返信と解決の操作が出て emit する', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row] [data-expand]').trigger('click');
    expect(w.text()).toContain('直しました');
    await w.find('[data-resolve]').trigger('click');
    expect(w.emitted('set-status')?.[0]).toEqual([entries[0], 'resolved']);
    await w.find('textarea[data-reply-content]').setValue('ありがとうございます');
    await w.find('button[data-reply-submit]').trigger('click');
    expect(w.emitted('reply')?.[0]).toEqual([entries[0], 'ありがとうございます']);
  });

  it('種別チェックボックスをつけると、状態「すべて」でもその種別だけに絞り込む', async () => {
    const w = mountPanel();
    await w.find('[data-filter-status]').setValue('all');
    expect(w.findAll('[data-comment-row]')).toHaveLength(2);
    await w.find('[data-filter-kind="question"]').setValue(true);
    const rows = w.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain('要約の数値');
  });

  it('パーツラベルが無い(削除済み)投稿は「削除済みパーツ」と表示し、行を控えめにする', () => {
    const deleted = entry({
      id: 'd',
      pathKey: 'gone-key',
      content: '消えたパーツへのコメント',
      createdAt: '2026-09-01T00:00:04.000Z',
    });
    const w = mountPanel({ entries: [...entries, deleted] });
    const row = w.findAll('[data-comment-row]').find((r) => r.text().includes('消えたパーツ'));
    expect(row).toBeTruthy();
    expect(row?.text()).toContain('削除済みパーツ');
    expect(row?.classes()).toContain('cursor-default');
    expect(row?.classes()).toContain('text-muted-foreground');
  });

  it('本文が空、または canAdd が false なら Ctrl+Enter でも追加を送らない', async () => {
    const w = mountPanel();
    const ta = w.find('textarea[data-add-content]');
    await ta.trigger('keydown', { ctrlKey: true, key: 'Enter' });
    expect(w.emitted('add')).toBeUndefined();

    const w2 = mountPanel({ canAdd: false });
    const ta2 = w2.find('textarea[data-add-content]');
    (ta2.element as HTMLTextAreaElement).value = '本文あり';
    await ta2.trigger('input');
    await ta2.trigger('keydown', { ctrlKey: true, key: 'Enter' });
    expect(w2.emitted('add')).toBeUndefined();
  });

  it('選択パーツが変わると下書きを空へ戻す', async () => {
    const w = mountPanel();
    await w.find('textarea[data-add-content]').setValue('書きかけ');
    await w.setProps({ selectedKey: SUMMARY });
    expect((w.find('textarea[data-add-content]').element as HTMLTextAreaElement).value).toBe('');
  });

  it('投稿者・並び順・選択パーツのみの絞り込みを操作できる', async () => {
    const own = [
      entry({
        id: 'x',
        createdBy: '山田',
        content: '山田の投稿',
        createdAt: '2026-09-01T00:00:01.000Z',
      }),
      entry({
        id: 'y',
        createdBy: '鈴木',
        pathKey: SUMMARY,
        content: '鈴木の投稿',
        createdAt: '2026-09-01T00:00:02.000Z',
      }),
    ];
    const w = mountPanel({ entries: own });

    await w.find('[data-filter-author]').setValue('鈴木');
    expect(w.findAll('[data-comment-row]')).toHaveLength(1);
    expect(w.find('[data-comment-row]').text()).toContain('鈴木の投稿');

    // 投稿者は `null`(「すべて」)へ戻さず、別インスタンスで並び順・選択パーツのみを確かめる
    // — `<option :value="null">` は jsdom の `setValue(null)` と相性が悪いため。
    const w2 = mountPanel({ entries: own });
    await w2.find('[data-filter-sort]').setValue('part');
    expect(w2.findAll('[data-comment-row]')).toHaveLength(2);

    await w2.find('[data-filter-selected]').setValue(true);
    const rows = w2.findAll('[data-comment-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].attributes('data-path-key')).toBe(COVER);
  });

  it('行を開いて編集し、保存すると update を emit する(取消は編集を捨てる)', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row] [data-expand]').trigger('click');
    await w.find('button[aria-label="このコメントを編集"]').trigger('click');
    const editArea = w.find('.mt-2 textarea.comment-area');
    await editArea.setValue('直した本文');
    await w
      .findAll('button')
      .find((b) => b.text() === '保存')
      ?.trigger('click');
    expect(w.emitted('update')?.[0]).toEqual([entries[0], '直した本文']);

    await w.find('button[aria-label="このコメントを編集"]').trigger('click');
    await w
      .findAll('button')
      .find((b) => b.text() === '取消')
      ?.trigger('click');
    expect(w.text()).not.toContain('保存');
  });

  it('返信を編集でき、Ctrl+Enter でも返信を送れる', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row] [data-expand]').trigger('click');
    await w.find('button[aria-label="この返信を編集"]').trigger('click');
    const editArea = w.find('.ml-3 textarea.comment-area');
    await editArea.setValue('編集した返信');
    await w
      .findAll('button')
      .find((b) => b.text() === '保存')
      ?.trigger('click');
    expect(w.emitted('update')?.[0]).toEqual([entries[1], '編集した返信']);

    await w.find('textarea[data-reply-content]').setValue('Ctrl+Enter の返信');
    await w
      .find('textarea[data-reply-content]')
      .trigger('keydown', { ctrlKey: true, key: 'Enter' });
    expect(w.emitted('reply')?.[0]).toEqual([entries[0], 'Ctrl+Enter の返信']);
  });

  it('削除ボタンは確認後に remove を emit する(親は返信も消える文言、返信は単独の文言)', async () => {
    const w = mountPanel();
    await w.find('[data-comment-row] [data-expand]').trigger('click');
    await w.find('button[aria-label="この返信を削除"]').trigger('click');
    resolveConfirm(true);
    await flushPromises();
    expect(w.emitted('remove')?.[0]).toEqual([entries[1]]);

    await w.find('button[aria-label="このコメントを削除"]').trigger('click');
    resolveConfirm(true);
    await flushPromises();
    expect(w.emitted('remove')?.[1]).toEqual([entries[0]]);
  });
});
