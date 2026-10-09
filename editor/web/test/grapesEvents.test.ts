import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { type GrapesEventDeps, wireGrapesEvents } from '@/features/editor/grapesEvents';

// =============================================================================
// grapesEvents.test.ts — content/style 変更の配線を検証する。fireChange はイベントごとに
// layout 変更の通知(`notifyLayoutChanged`)・move・change を即時に呼び、重い再計測の
// 間引き(rAF 1 フレーム 1 回)は通知の先(`useGrapes.ts` の `scheduleLayoutRecompute`、
// `rafOnce.test.ts`)が担う。`recomputeLayout` は `load` で同期に 1 回だけ走る。
// =============================================================================

/** `ed.on(names, cb)` を記録し `emit(name)` で発火できる最小の偽 editor。 */
function makeFakeEditor() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const ed = {
    on(names: string, cb: (...a: unknown[]) => void) {
      for (const n of names.split(/\s+/)) {
        handlers[n] ??= [];
        handlers[n].push(cb);
      }
    },
    emit(name: string, ...args: unknown[]) {
      for (const cb of handlers[name] ?? []) cb(...args);
    },
    // fireChange / load 経路では未使用だが、型/呼び出しの保険として最小実装。
    getSelected: () => null,
    getEditing: () => undefined,
  };
  return ed as typeof ed & Editor;
}

/** rAF を手動フラッシュ可能にする。`flush()` で保留中コールバックを 1 フレーム分実行。 */
function stubRaf() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  return () => {
    const due = queue;
    queue = [];
    for (const cb of due) cb(0);
  };
}

function setup() {
  const ed = makeFakeEditor();
  const spies = {
    refreshRect: vi.fn(),
    refreshMove: vi.fn(),
    refreshPageGuides: vi.fn(),
    recomputeLayout: vi.fn(),
    notifyLayoutChanged: vi.fn(),
    change: vi.fn(),
  };
  // 偽の依存。`GrapesEventDeps` の細部型(SelectedInfo 等)はテスト挙動に無関係なため
  // まとめてキャストする(実行時の呼び出しは spy で観測する)。
  const deps = {
    selected: ref(null),
    selectedRect: ref(null),
    refreshRect: spies.refreshRect,
    refreshMove: spies.refreshMove,
    refreshPageGuides: spies.refreshPageGuides,
    recomputeLayout: spies.recomputeLayout,
    notifyLayoutChanged: spies.notifyLayoutChanged,
    applyInitialZoom: vi.fn(),
    onCanvasLoad: vi.fn(),
    toInfo: vi.fn(),
    isLocked: () => false,
    isApplyingLockState: () => false,
    canvasCss: '',
    callbacks: { change: spies.change },
  } as unknown as GrapesEventDeps;
  wireGrapesEvents(ed, deps);
  return { ed, spies };
}

describe('wireGrapesEvents — fireChange の即時部', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('content/style 変更のたびに通知・move・change が即時に走り、再計測は直接走らせない', () => {
    stubRaf();
    const { ed, spies } = setup();

    // 連続発火を模す(テキスト入力中の component:update 連打など)。
    ed.emit('component:update');
    ed.emit('component:add');
    ed.emit('component:remove');
    ed.emit('component:styleUpdate');
    ed.emit('component:update');

    expect(spies.notifyLayoutChanged).toHaveBeenCalledTimes(5);
    expect(spies.refreshMove).toHaveBeenCalledTimes(5);
    expect(spies.change).toHaveBeenCalledTimes(5);
    // 間引きは通知の先が担う。ここからは `load` 以外で `recomputeLayout` を呼ばない。
    expect(spies.recomputeLayout).not.toHaveBeenCalled();
  });

  it('load で recomputeLayout を同期に 1 回走らせる', () => {
    stubRaf();
    const { ed, spies } = setup();
    (ed as unknown as { Canvas: unknown }).Canvas = { getDocument: () => null };
    ed.emit('load');
    expect(spies.recomputeLayout).toHaveBeenCalledTimes(1);
  });
});

describe('wireGrapesEvents — 編集可否切替中の dirty 抑制', () => {
  afterEach(() => vi.unstubAllGlobals());

  // `setEditable` は全 Component へ `editable`/`draggable` を set して回り、保存内容の
  // 変わらない `component:update` を大量発火させる。change(dirty/autosave)へ流すと
  // 「編集を許可を触っただけで未確定 + 無編集 draft 生成」になるため、適用中は
  // change だけを止め、幾何の追随(layout 変更の通知)は生かす — が確認したい不変条件。
  it('isApplyingLockState 中の component:update は change を呼ばず 通知は進む', () => {
    stubRaf();
    const ed = makeFakeEditor();
    const spies = { change: vi.fn() };
    const notifyLayoutChanged = vi.fn();
    let applying = false;
    const deps = {
      selected: ref(null),
      selectedRect: ref(null),
      refreshRect: vi.fn(),
      refreshMove: vi.fn(),
      refreshPageGuides: vi.fn(),
      recomputeLayout: vi.fn(),
      notifyLayoutChanged,
      applyInitialZoom: vi.fn(),
      onCanvasLoad: vi.fn(),
      toInfo: vi.fn(),
      isLocked: () => false,
      isApplyingLockState: () => applying,
      canvasCss: '',
      callbacks: { change: spies.change },
    } as unknown as GrapesEventDeps;
    wireGrapesEvents(ed, deps);

    applying = true;
    ed.emit('component:update');
    ed.emit('component:update');
    expect(spies.change).not.toHaveBeenCalled();
    expect(notifyLayoutChanged).toHaveBeenCalledTimes(2);

    // 切替適用が終われば通常の変更は従来どおり dirty へ届く。
    applying = false;
    ed.emit('component:update');
    expect(spies.change).toHaveBeenCalledTimes(1);
  });
});

// パーツをクリック選択すると Layers が祖先へ `open:true` を、GrapesJS が `status` を set し、
// どちらも `component:update` を発火させる。保存内容に現れない UI 状態なので dirty/autosave へ
// 流さない(主防御は内容比較。これは即時応答用の補助)。内容の変更は従来どおり届く。
describe('wireGrapesEvents — 保存内容に現れない prop だけの component:update', () => {
  function emitUpdate(ed: ReturnType<typeof makeFakeEditor>, changed: Record<string, unknown>) {
    ed.emit('component:update', { changed });
  }

  it('open / status だけの更新は change を呼ばず、通知は進む', () => {
    stubRaf();
    const { ed, spies } = setup();
    emitUpdate(ed, { open: true });
    emitUpdate(ed, { status: 'selected' });
    emitUpdate(ed, { open: true, status: 'hovered' });
    expect(spies.change).not.toHaveBeenCalled();
    expect(spies.notifyLayoutChanged).toHaveBeenCalledTimes(3);
  });

  it('内容の変更を含む更新は change を呼ぶ(UI 状態と混ざっていても)', () => {
    stubRaf();
    const { ed, spies } = setup();
    emitUpdate(ed, { content: 'x' });
    emitUpdate(ed, { open: true, attributes: { id: 'a' } });
    expect(spies.change).toHaveBeenCalledTimes(2);
  });

  it('changed が読めない発火(引数なし / 空)は保守的に change を呼ぶ', () => {
    stubRaf();
    const { ed, spies } = setup();
    ed.emit('component:update');
    emitUpdate(ed, {});
    expect(spies.change).toHaveBeenCalledTimes(2);
  });
});

// ドラッグの移動判定は「親か兄弟内の位置のどちらか」が変わったときだけ true。別ページ(親)へ
// 同じ番目で移した場合も記録しないと cancelUndo が Undo の 1 手を落とす。
describe('wireGrapesEvents — ドラッグ移動の判定', () => {
  function drag(start: { p: object; i: number }, end: { p: object; i: number }) {
    const ed = makeFakeEditor();
    let cur = start;
    ed.getSelected = (() => ({ index: () => cur.i, parent: () => cur.p })) as never;
    const reorderEnd = vi.fn();
    const deps = {
      selected: ref(null),
      selectedRect: ref(null),
      refreshRect: vi.fn(),
      refreshMove: vi.fn(),
      refreshPageGuides: vi.fn(),
      recomputeLayout: vi.fn(),
      notifyLayoutChanged: vi.fn(),
      applyInitialZoom: vi.fn(),
      onCanvasLoad: vi.fn(),
      toInfo: vi.fn(),
      isLocked: () => false,
      isApplyingLockState: () => false,
      canvasCss: '',
      callbacks: { change: vi.fn(), reorderStart: vi.fn(), reorderEnd },
    } as unknown as GrapesEventDeps;
    wireGrapesEvents(ed, deps);
    ed.emit('component:drag:start');
    cur = end;
    ed.emit('component:drag:end');
    return reorderEnd;
  }
  const pageA = {};
  const pageB = {};

  it('別の親の同じ番目へ移したら移動', () => {
    expect(drag({ p: pageA, i: 2 }, { p: pageB, i: 2 })).toHaveBeenCalledWith(true);
  });
  it('同じ親の別の番目なら移動', () => {
    expect(drag({ p: pageA, i: 2 }, { p: pageA, i: 3 })).toHaveBeenCalledWith(true);
  });
  it('同じ親の同じ番目なら移動していない', () => {
    expect(drag({ p: pageA, i: 2 }, { p: pageA, i: 2 })).toHaveBeenCalledWith(false);
  });
});
