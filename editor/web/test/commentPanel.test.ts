import type { PartNoteEntry } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
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
});
