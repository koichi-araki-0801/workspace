import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { type GrapesEventDeps, wireGrapesEvents } from '@/features/editor/grapesEvents';

// =============================================================================
// grapesEvents.test.ts — content/style 変更時の重い再計測が rAF で 1 フレーム
// 1 回へ集約される(coalescing)ことを検証する。fireChange の即時部
// (revision/rect/move/change)はイベントごとに走り、重い `recomputeLayout`
// (break 集合 → guide → ページ列挙 → 縦配置)はフレーム単位で束ねられる、が
// 確認したい不変条件。順序は `recomputeLayout` 内部の詳細(useGrapes 側)。
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
    change: vi.fn(),
  };
  const revision = ref(0);
  // 偽の依存。`GrapesEventDeps` の細部型(SelectedInfo 等)はテスト挙動に無関係なため
  // まとめてキャストする(実行時の呼び出しは spy で観測する)。
  const deps = {
    selected: ref(null),
    selectedRect: ref(null),
    revision,
    zoom: ref(1),
    refreshRect: spies.refreshRect,
    refreshMove: spies.refreshMove,
    refreshPageGuides: spies.refreshPageGuides,
    recomputeLayout: spies.recomputeLayout,
    fitToView: vi.fn(),
    onCanvasLoad: vi.fn(),
    toInfo: vi.fn(),
    isLocked: () => false,
    canvasCss: '',
    callbacks: { change: spies.change },
  } as unknown as GrapesEventDeps;
  wireGrapesEvents(ed, deps);
  return { ed, spies, revision };
}

describe('wireGrapesEvents — fireChange の重い再計測 coalescing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('複数の content/style 変更を 1 フレームへ束ね、recomputeLayout は 1 回だけ走る', () => {
    const flush = stubRaf();
    const { ed, spies, revision } = setup();

    // 連続発火を模す(テキスト入力中の component:update 連打など)。
    ed.emit('component:update');
    ed.emit('component:add');
    ed.emit('component:remove');
    ed.emit('component:styleUpdate');
    ed.emit('component:update');

    // 即時部はイベントごとに走る。
    expect(revision.value).toBe(5);
    expect(spies.refreshRect).toHaveBeenCalledTimes(5);
    expect(spies.refreshMove).toHaveBeenCalledTimes(5);
    expect(spies.change).toHaveBeenCalledTimes(5);

    // 重い再計測はフレーム前には未実行(集約待ち)。
    expect(spies.recomputeLayout).not.toHaveBeenCalled();

    // 1 フレーム経過 — 5 連打が 1 回に集約される。
    flush();
    expect(spies.recomputeLayout).toHaveBeenCalledTimes(1);
  });

  it('次フレームでは再スケジュールされ、recomputeLayout がもう一度走る', () => {
    const flush = stubRaf();
    const { ed, spies } = setup();

    ed.emit('component:update');
    flush();
    expect(spies.recomputeLayout).toHaveBeenCalledTimes(1);

    ed.emit('component:update');
    ed.emit('component:update');
    flush();
    expect(spies.recomputeLayout).toHaveBeenCalledTimes(2);
  });
});
