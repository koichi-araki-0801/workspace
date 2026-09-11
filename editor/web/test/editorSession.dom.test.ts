import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUndoUserScope, undoStacksKey } from '@/lib/storageKeys';
import {
  defaultEditorUiState,
  type EditorSnapshot,
  useEditorSessionStore,
} from '@/stores/editorSession';

/** localStorage の Undo 永続ミラーを読む(テスト用)。 */
function readUndoMap(): Record<string, { past: EditorSnapshot[]; future: EditorSnapshot[] }> {
  return JSON.parse(localStorage.getItem(undoStacksKey()) ?? '{}');
}

describe('useEditorSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    // 既定は rest(= ログイン ID スコープ)なので、キー名を直書きする検証は local を明示する。
    vi.stubEnv('VITE_API_MODE', 'local');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ensure() creates an empty session and returns the same instance on re-ensure', () => {
    const store = useEditorSessionStore();
    const a = store.ensure('t1');
    expect(a).toEqual({
      partHistory: {},
      seq: 0,
      undoPast: [],
      undoFuture: [],
      ui: defaultEditorUiState(),
    });

    // 同一 templateId を再度 ensure すると、同じセッション(参照)が返る
    // (= 編集⇄プレビュー往復で履歴が維持される)。
    a.seq = 3;
    a.undoPast.push({ html: '<p>x</p>', css: '.c{}' });
    const again = store.ensure('t1');
    expect(again).toBe(a);
    expect(again.seq).toBe(3);
    expect(again.undoPast).toHaveLength(1);
  });

  it('keeps sessions isolated per templateId', () => {
    const store = useEditorSessionStore();
    store.ensure('t1').seq = 1;
    const t2 = store.ensure('t2');
    expect(t2.seq).toBe(0);
  });

  it('clear() drops the session so the next ensure() starts fresh', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.seq = 5;
    s.undoPast.push({ html: 'h', css: 'c' });
    store.clear('t1');
    const fresh = store.ensure('t1');
    expect(fresh).not.toBe(s);
    expect(fresh).toEqual({
      partHistory: {},
      seq: 0,
      undoPast: [],
      undoFuture: [],
      ui: defaultEditorUiState(),
    });
  });

  it('clear() on an unknown templateId is a no-op', () => {
    const store = useEditorSessionStore();
    expect(() => store.clear('missing')).not.toThrow();
  });

  it('persist() mirrors Undo/Redo to localStorage and ensure() hydrates it back', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: '<p>a</p>', css: '.a{}' });
    s.undoFuture.push({ html: '<p>b</p>', css: '.b{}' });
    store.persist('t1');

    const map = readUndoMap();
    expect(map.t1.past).toHaveLength(1);
    expect(map.t1.future).toHaveLength(1);

    // 新しい Pinia(= リロード相当)でも ensure が永続ミラーから復元する。
    setActivePinia(createPinia());
    const reloaded = useEditorSessionStore();
    const r = reloaded.ensure('t1');
    expect(r.undoPast[0]).toEqual({ html: '<p>a</p>', css: '.a{}' });
    expect(r.undoFuture[0]).toEqual({ html: '<p>b</p>', css: '.b{}' });
  });

  it('persist() caps the mirrored undo depth to 20 (in-memory stays full)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    for (let i = 0; i < 30; i++) s.undoPast.push({ html: `h${i}`, css: '' });
    store.persist('t1');

    expect(s.undoPast).toHaveLength(30); // in-memory は丸めない
    const map = readUndoMap();
    expect(map.t1.past).toHaveLength(20); // 永続ミラーは直近 20 件
    expect(map.t1.past[19]).toEqual({ html: 'h29', css: '' }); // 末尾=最新を残す
  });

  it('persist() keeps the newest redo entries (future tail = next redo target)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    for (let i = 0; i < 30; i++) s.undoFuture.push({ html: `f${i}`, css: '' });
    store.persist('t1');

    const map = readUndoMap();
    expect(map.t1.future).toHaveLength(20);
    // `useSnapshotHistory` の redo は future の末尾から取り出すため、末尾側を残す。
    expect(map.t1.future[19]).toEqual({ html: 'f29', css: '' });
  });

  it('clear() also removes the persisted undo mirror', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: 'h', css: 'c' });
    store.persist('t1');
    expect(readUndoMap().t1).toBeDefined();

    store.clear('t1');
    expect(readUndoMap().t1).toBeUndefined();
  });

  it('reset() は Undo スタックを in-place で空にし、ミラーも空にする', () => {
    // 別タブが残した下書きを破棄して確定版から開いたときの後始末。`useSnapshotHistory` が
    // 配列を参照で握っているため、差し替えではなく in-place で空にする必要がある。
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    const past = s.undoPast;
    const future = s.undoFuture;
    past.push({ html: '<p>stale</p>', css: '.a{}' });
    future.push({ html: '<p>redo</p>', css: '.b{}' });
    s.partHistory = { k1: [] };
    s.seq = 7;
    store.persist('t1');
    expect(readUndoMap().t1.past).toHaveLength(1);

    store.reset('t1');
    // 先に取った参照そのものが空になっている(配列を差し替えていない)。
    expect(past).toEqual([]);
    expect(future).toEqual([]);
    expect(store.ensure('t1').undoPast).toBe(past);
    // 修正履歴と採番は残す(Undo だけを捨てる)。
    expect(s.partHistory).toEqual({ k1: [] });
    expect(s.seq).toBe(7);
    // ミラーも空になっている(リロードで再び hydrate されない)。
    expect(readUndoMap().t1).toEqual({ past: [], future: [] });
  });

  it('undo ミラーの JSON が壊れていても空として読む', () => {
    localStorage.setItem(undoStacksKey(), '{not json');
    const store = useEditorSessionStore();
    expect(() => store.ensure('t1')).not.toThrow();
    expect(store.ensure('t1').undoPast).toEqual([]);
  });

  it('未知の templateId への persist は no-op(localStorage を触らない)', () => {
    const store = useEditorSessionStore();
    // ensure() を呼んでいないので sessions['no-such'] は存在しない。
    expect(() => store.persist('no-such')).not.toThrow();
    expect(localStorage.getItem(undoStacksKey())).toBeNull();
  });

  it('容量超過では他テンプレを古い側から間引いて再試行する', () => {
    const store = useEditorSessionStore();
    for (const id of ['a', 'b']) {
      const s = store.ensure(id);
      s.undoPast.push({ html: 'x', css: '' });
      store.persist(id);
    }
    const real = localStorage.setItem.bind(localStorage);
    let fails = 2;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k,
      v,
    ) {
      if (k === undoStacksKey() && fails-- > 0) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return real(k, v);
    });
    try {
      const c = store.ensure('c');
      c.undoPast.push({ html: 'y', css: '' });
      store.persist('c');
    } finally {
      spy.mockRestore();
    }
    const map = readUndoMap();
    expect(map.c).toBeDefined();
    expect(Object.keys(map)).not.toContain('a');
  });

  it('他テンプレが無いとき、容量超過は自身の深度を半減して保存を試みる', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('c');
    for (let i = 0; i < 4; i++) s.undoPast.push({ html: `h${i}`, css: '' });
    const real = localStorage.setItem.bind(localStorage);
    let fails = 1;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      k,
      v,
    ) {
      if (k === undoStacksKey() && fails-- > 0) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return real(k, v);
    });
    try {
      store.persist('c');
    } finally {
      spy.mockRestore();
    }
    const map = readUndoMap();
    // 他テンプレが無く間引く先が無いので、深度半減(4 → 2、末尾=最新を残す)で保存できる。
    expect(map.c.past).toHaveLength(2);
    expect(map.c.past[1]).toEqual({ html: 'h3', css: '' });
  });

  it('persist() never throws when localStorage.setItem fails (best-effort)', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    s.undoPast.push({ html: 'h', css: 'c' });
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      expect(() => store.persist('t1')).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('ui 状態は再 ensure で残り、倍率・表示系だけが localStorage へ永続し、allowEdit と選択は永続しない', () => {
    const store = useEditorSessionStore();
    const s = store.ensure('t1');
    expect(s.ui).toEqual({
      allowEdit: false,
      redlineEnabled: false,
      paneTab: 'props',
      zoom: null,
      singlePageMode: true,
      currentPage: 0,
      showPageGuides: true,
      selectedKey: null,
    });
    s.ui.allowEdit = true;
    s.ui.zoom = 1.2;
    s.ui.paneTab = 'comments';
    s.ui.selectedKey = 'p1/.x#2';
    s.ui.redlineEnabled = true;
    store.persistUi('t1');
    expect(store.ensure('t1').ui).toMatchObject({
      allowEdit: true,
      zoom: 1.2,
      paneTab: 'comments',
      selectedKey: 'p1/.x#2',
      redlineEnabled: true,
    });
    const persisted = JSON.parse(localStorage.getItem('editor:session:ui:local') ?? '{}');
    expect(persisted.t1).toEqual({
      redlineEnabled: true,
      paneTab: 'comments',
      zoom: 1.2,
      singlePageMode: true,
      currentPage: 0,
      showPageGuides: true,
    });
  });

  it('新しいセッションは永続した ui から hydrate し、allowEdit と選択は既定に戻る', () => {
    localStorage.setItem(
      'editor:session:ui:local',
      JSON.stringify({
        t1: {
          redlineEnabled: true,
          paneTab: 'comments',
          zoom: 0.8,
          singlePageMode: false,
          currentPage: 2,
          showPageGuides: false,
        },
      }),
    );
    const store = useEditorSessionStore();
    expect(store.ensure('t1').ui).toEqual({
      allowEdit: false,
      redlineEnabled: true,
      paneTab: 'comments',
      zoom: 0.8,
      singlePageMode: false,
      currentPage: 2,
      showPageGuides: false,
      selectedKey: null,
    });
  });

  it('clear() は ui と永続分も消す', () => {
    const store = useEditorSessionStore();
    store.ensure('t1').ui.zoom = 0.8;
    store.persistUi('t1');
    store.clear('t1');
    expect(store.ensure('t1').ui.zoom).toBeNull();
    expect(JSON.parse(localStorage.getItem('editor:session:ui:local') ?? '{}').t1).toBeUndefined();
  });

  it('永続ミラーが壊れた値を持っていても、既定値へフォールバックして復元する', () => {
    // 破損経路の例: 手動編集・旧バージョンとの互換切れ・localStorage 共有の事故。
    // 型不整合のまま `setZoom` 等へ渡すと NaN clamp 等の実害があるため、hydrate 時点で防ぐ。
    localStorage.setItem(
      'editor:session:ui:local',
      JSON.stringify({
        t1: {
          zoom: 'big',
          currentPage: -3,
          paneTab: 'x',
          redlineEnabled: 'yes',
        },
      }),
    );
    const store = useEditorSessionStore();
    expect(store.ensure('t1').ui).toEqual(defaultEditorUiState());
  });
});

// 共有端末では Undo ミラーが localStorage に残る。ユーザーを跨いで復元されると、前の
// 利用者の編集内容が次の利用者の画面へ出るため、キーは利用者ごとに分ける。
describe('Undo ミラーのユーザー分離', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setUndoUserScope(null);
  });

  it('local は単一利用者前提の固定スコープを使う', () => {
    vi.stubEnv('VITE_API_MODE', 'local');
    setUndoUserScope('alice');
    expect(undoStacksKey()).toBe('editor:session:undo:v2:local');
  });

  it('Undo ミラーのキーは v2 で、旧形式のミラーは読まない', () => {
    vi.stubEnv('VITE_API_MODE', 'local');
    localStorage.setItem(
      'editor:session:undo:local',
      JSON.stringify({ t1: { past: [{ html: 'old', css: '' }], future: [] } }),
    );
    const store = useEditorSessionStore();
    expect(store.ensure('t1').undoPast).toEqual([]);
    expect(undoStacksKey()).toBe('editor:session:undo:v2:local');
  });

  it('rest はログイン ID ごとに別キーで、他ユーザーの内容へ到達しない', () => {
    vi.stubEnv('VITE_API_MODE', 'rest');
    setUndoUserScope('alice');
    const keyA = undoStacksKey();
    const s = useEditorSessionStore().ensure('t1');
    s.undoPast.push({ html: '<p>alice</p>', css: '' });
    useEditorSessionStore().persist('t1');
    expect(localStorage.getItem(keyA)).toContain('alice');

    setUndoUserScope('bob');
    expect(undoStacksKey()).not.toBe(keyA);
    // 別ユーザーでの再マウント(= 新しい Pinia)でも A の内容は hydrate されない。
    setActivePinia(createPinia());
    expect(useEditorSessionStore().ensure('t1').undoPast).toEqual([]);
  });

  it('rest で未ログインなら anonymous スコープへ隔離する', () => {
    vi.stubEnv('VITE_API_MODE', 'rest');
    setUndoUserScope(null);
    expect(undoStacksKey()).toBe('editor:session:undo:v2:anonymous');
  });

  it('VITE_API_MODE 未設定でも Undo ミラーはログイン ID でスコープされる(既定は rest)', () => {
    vi.stubEnv('VITE_API_MODE', '');
    setUndoUserScope('alice');
    const keyA = undoStacksKey();
    const s = useEditorSessionStore().ensure('t1');
    s.undoPast.push({ html: '<p>alice</p>', css: '' });
    useEditorSessionStore().persist('t1');
    expect(localStorage.getItem(keyA)).toContain('alice');

    setUndoUserScope('bob');
    expect(undoStacksKey()).not.toBe(keyA);
    setActivePinia(createPinia());
    expect(useEditorSessionStore().ensure('t1').undoPast).toEqual([]);
  });
});
