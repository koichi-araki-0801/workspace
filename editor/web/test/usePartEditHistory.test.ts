import type { PartHistoryEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import { usePartEditHistory } from '@/features/editor/usePartEditHistory';

function persistedEntry(id: string): PartHistoryEntry {
  return {
    id,
    templateId: 't1',
    partId: 'p1',
    change: 'persisted',
    timestamp: '2024-01-01T00:00:00.000Z',
    user: '過去',
  };
}

describe('usePartEditHistory', () => {
  it('records an entry against the current selection', () => {
    const cid = ref<string | undefined>('p1');
    const { record, displayHistory } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
    );
    record('幅を変更');
    expect(displayHistory.value).toHaveLength(1);
    expect(displayHistory.value[0]).toMatchObject({
      templateId: 't1',
      partId: 'p1',
      change: '幅を変更',
      user: '編集者',
    });
  });

  it('ignores record() when nothing is selected', () => {
    const { record, displayHistory } = usePartEditHistory(
      't1',
      () => undefined,
      () => '編集者',
      () => [],
    );
    record('何か');
    expect(displayHistory.value).toHaveLength(0);
  });

  it('keeps session entries per part and newest-first', () => {
    const cid = ref<string | undefined>('p1');
    const { record, displayHistory } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
    );
    record('一回目');
    record('二回目');
    expect(displayHistory.value.map((e) => e.change)).toEqual(['二回目', '一回目']);

    // switching selection shows that part's (empty) history, not p1's
    cid.value = 'p2';
    expect(displayHistory.value).toHaveLength(0);
    // back to p1 — its entries are retained
    cid.value = 'p1';
    expect(displayHistory.value.map((e) => e.change)).toEqual(['二回目', '一回目']);
  });

  it('merges session edits ahead of persisted history', () => {
    const cid = ref<string | undefined>('p1');
    const persisted = ref<PartHistoryEntry[]>([persistedEntry('h1')]);
    const { record, displayHistory } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => persisted.value,
    );
    record('セッション編集');
    expect(displayHistory.value.map((e) => e.change)).toEqual(['セッション編集', 'persisted']);
  });

  it('forwards recorded edits to the persist sink (partId + change)', () => {
    const cid = ref<string | undefined>('p1');
    const calls: Array<[string, string]> = [];
    const { record } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
      (partId, change) => calls.push([partId, change]),
    );
    record('幅を変更');
    cid.value = undefined;
    record('無視される'); // no selection → no persist
    expect(calls).toEqual([['p1', '幅を変更']]);
  });

  // 外部 state(editorSession ストア由来)を渡すと、履歴と採番をその store に委ねる。
  // 別インスタンスでも同じ store を渡せば履歴が継続する(プレビュー往復の維持を模す)。
  it('records into the external session state and survives a re-instantiation', () => {
    const cid = ref<string | undefined>('p1');
    // 本番では editorSession ストアの reactive state を渡す。computed の依存追跡が
    // 効くよう、テストでも reactive で包む。
    const history = reactive<Record<string, PartHistoryEntry[]>>({});
    let seq = 0;
    const init = { history, nextSeq: () => ++seq };
    const first = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
      undefined,
      init,
    );
    first.record('一回目');
    expect(history.p1).toHaveLength(1);
    expect(history.p1[0].id).toBe('s1');

    // 再マウントを模して別インスタンスに同じ store を渡す → 既存履歴が見える。
    const second = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
      undefined,
      init,
    );
    expect(second.displayHistory.value.map((e) => e.change)).toEqual(['一回目']);
    second.record('二回目');
    expect(second.displayHistory.value.map((e) => e.change)).toEqual(['二回目', '一回目']);
    expect(history.p1[0].id).toBe('s2'); // 採番は store の seq を継続
  });
});
