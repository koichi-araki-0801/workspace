import type { PartHistoryEntry } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import { usePartEditHistory } from '@/features/editor/usePartEditHistory';

function persistedEntry(id: string): PartHistoryEntry {
  return {
    id,
    templateId: 't1',
    partKey: 'p1',
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
      partKey: 'p1',
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

  // 未選択(画面を開いた当初)は全パーツの history を併合し timestamp 降順で俯瞰表示する。
  // セッション/永続の双方が複数パーツにまたがり、timestamp 降順で interleave されること。
  it('shows all parts merged newest-first when nothing is selected', () => {
    const cid = ref<string | undefined>(undefined);
    const sessEntry = (
      id: string,
      partKey: string,
      change: string,
      ts: string,
    ): PartHistoryEntry => ({
      id,
      templateId: 't1',
      partKey,
      change,
      timestamp: ts,
      user: '編集者',
    });
    const history = reactive<Record<string, PartHistoryEntry[]>>({
      p1: [sessEntry('s1', 'p1', 'p1 セッション', '2024-01-02T00:00:00.000Z')],
      p2: [sessEntry('s2', 'p2', 'p2 セッション', '2024-01-04T00:00:00.000Z')],
    });
    const persisted: PartHistoryEntry[] = [
      {
        ...persistedEntry('h1'),
        partKey: 'p1',
        change: 'p1 永続',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        ...persistedEntry('h2'),
        partKey: 'p2',
        change: 'p2 永続',
        timestamp: '2024-01-03T00:00:00.000Z',
      },
    ];
    const { displayHistory } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      // 未選択(key 未指定)なら全件、選択中はそのパーツのみ。
      (key) => (key ? persisted.filter((e) => e.partKey === key) : persisted),
      undefined,
      { history, nextSeq: () => 1 },
    );
    // 未選択: 全 4 件(セッション 2 + 永続 2)が timestamp 降順で interleave。
    expect(displayHistory.value.map((e) => e.change)).toEqual([
      'p2 セッション', // 2024-01-04
      'p2 永続', // 2024-01-03
      'p1 セッション', // 2024-01-02
      'p1 永続', // 2024-01-01
    ]);
    // 選択すればそのパーツのみ(セッション先頭 + 永続)に絞る。
    cid.value = 'p1';
    expect(displayHistory.value.map((e) => e.change)).toEqual(['p1 セッション', 'p1 永続']);
  });

  it('forwards recorded edits to the persist sink (partKey + change)', () => {
    const cid = ref<string | undefined>('p1');
    const calls: Array<[string, string]> = [];
    const { record } = usePartEditHistory(
      't1',
      () => cid.value,
      () => '編集者',
      () => [],
      (partKey, change) => calls.push([partKey, change]),
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
