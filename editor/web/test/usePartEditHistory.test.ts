import type { PartHistoryEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
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
});
