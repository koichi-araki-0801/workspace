import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { DEFAULT_GEOM, type LayoutGeom } from '@/features/editor/geom';
import type { SelectedRect } from '@/features/editor/grapesEvents';
import { useGeomHandles } from '@/features/editor/useGeomHandles';

function setup(
  geom: LayoutGeom = { ...DEFAULT_GEOM, widthPct: 50, align: 'left' },
  textEditing = false,
) {
  const selectedGeom = computed(() => geom);
  const selectedRect = ref<SelectedRect | null>({ left: 100, top: 50, width: 200, height: 80 });
  const zoom = ref(1);
  const beginUndo = vi.fn();
  const applyGeom = vi.fn();
  const recordGeomDiff = vi.fn();
  const finishTextEdit = vi.fn(() => Promise.resolve(true));
  const api = useGeomHandles({
    selectedGeom,
    selectedRect,
    zoom,
    beginUndo,
    applyGeom,
    recordGeomDiff,
    isTextEditing: () => textEditing,
    finishTextEdit,
  });
  return { api, beginUndo, applyGeom, recordGeomDiff, finishTextEdit };
}

/**
 * jsdom には `PointerEvent` が無い版があるので、`MouseEvent` に `pointerId` を足して代用する。
 * `useGeomHandles` が読むのは座標と `pointerId` だけ。
 */
const ptr = (type: string, x: number, y: number) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }), {
    pointerId: 1,
  }) as unknown as PointerEvent;

describe('useGeomHandles', () => {
  // ハンドルの押下は伝播を止めるので、GrapesJS がほかのクリックで閉じるテキスト編集が
  // 閉じない。閉じる前に drag を始めると追記が幾何の 1 手に混ざるため、閉じ終えてから同じ押下の
  // 位置を起点に drag を始める。
  it('テキスト編集中の押下は編集を閉じ終えてから、押した位置を起点に drag を始める', async () => {
    const { api, beginUndo, applyGeom, recordGeomDiff, finishTextEdit } = setup(undefined, true);
    const order: string[] = [];
    finishTextEdit.mockImplementation(async () => {
      order.push('closed');
      return true;
    });
    beginUndo.mockImplementation(() => order.push('beginUndo'));
    api.startHandle('width', ptr('pointerdown', 300, 90));
    expect(beginUndo).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['closed', 'beginUndo']);
    expect(api.activeHandle.value).toBe('width');
    window.dispatchEvent(ptr('pointermove', 500, 90)); // 押した位置から +200px → 100%
    expect(applyGeom).toHaveBeenLastCalledWith(expect.objectContaining({ widthPct: 100 }), false);
    window.dispatchEvent(ptr('pointerup', 500, 90));
    expect(recordGeomDiff).toHaveBeenCalledTimes(1);
  });

  it('編集を閉じ終わる前に離されたら drag を始めない', async () => {
    const { api, beginUndo, applyGeom, finishTextEdit } = setup(undefined, true);
    let close: () => void = () => {};
    finishTextEdit.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          close = () => r(true);
        }),
    );
    api.startHandle('mb', ptr('pointerdown', 200, 130));
    window.dispatchEvent(ptr('pointerup', 200, 130));
    close();
    await Promise.resolve();
    await Promise.resolve();
    expect(beginUndo).not.toHaveBeenCalled();
    expect(api.activeHandle.value).toBeNull();
    window.dispatchEvent(ptr('pointermove', 200, 200));
    expect(applyGeom).not.toHaveBeenCalled();
  });

  it('編集を閉じ終わる前に捕まえが外れたら drag を始めない', async () => {
    const { api, beginUndo, finishTextEdit } = setup(undefined, true);
    let close: () => void = () => {};
    finishTextEdit.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          close = () => r(true);
        }),
    );
    api.startHandle('mb', ptr('pointerdown', 200, 130));
    window.dispatchEvent(ptr('lostpointercapture', 200, 130));
    close();
    await Promise.resolve();
    await Promise.resolve();
    expect(beginUndo).not.toHaveBeenCalled();
    expect(api.activeHandle.value).toBeNull();
  });

  it('テキスト編集を閉じられなかったら drag を始めない', async () => {
    const { api, beginUndo, applyGeom, finishTextEdit } = setup(undefined, true);
    finishTextEdit.mockResolvedValue(false);
    api.startHandle('mb', ptr('pointerdown', 200, 130));
    await Promise.resolve();
    await Promise.resolve();
    expect(beginUndo).not.toHaveBeenCalled();
    expect(api.activeHandle.value).toBeNull();
    window.dispatchEvent(ptr('pointermove', 200, 200));
    expect(applyGeom).not.toHaveBeenCalled();
  });

  // ハンドルの外(canvas の iframe の上)の移動と離す操作も受けるため、押下で pointer を捕まえる。
  it('押下でハンドルへ pointer を捕まえる', () => {
    const { api } = setup();
    const handle = document.createElement('div');
    const setPointerCapture = vi.fn();
    Object.assign(handle, { setPointerCapture });
    handle.addEventListener('pointerdown', (e) => api.startHandle('mb', e as PointerEvent));
    handle.dispatchEvent(ptr('pointerdown', 200, 130));
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    window.dispatchEvent(ptr('pointerup', 200, 130));
  });

  // drag 中にハンドルが外れると pointerup が来ない。捕まえが外れたら片付けないと、drag と
  // Undo の保留が残り続ける。
  it('drag 中に捕まえが外れたら、離したのと同じく片付ける', () => {
    const { api, applyGeom, recordGeomDiff } = setup();
    api.startHandle('mb', ptr('pointerdown', 200, 130));
    window.dispatchEvent(ptr('lostpointercapture', 200, 130));
    expect(recordGeomDiff).toHaveBeenCalledTimes(1);
    expect(api.activeHandle.value).toBeNull();
    window.dispatchEvent(ptr('pointermove', 200, 200));
    expect(applyGeom).not.toHaveBeenCalled();
  });

  it('テキスト編集中でなければ編集を閉じる処理を呼ばない', () => {
    const { api, finishTextEdit } = setup();
    api.startHandle('mb', ptr('pointerdown', 200, 130));
    expect(finishTextEdit).not.toHaveBeenCalled();
    window.dispatchEvent(ptr('pointerup', 200, 130));
  });

  it('width drag: begins one undo, live-applies width without recording, logs diff on pointerup', () => {
    const { api, beginUndo, applyGeom, recordGeomDiff } = setup();
    // fullW = width / (widthPct/100) = 200 / 0.5 = 400px for 100%.
    api.startHandle('width', ptr('pointerdown', 300, 90));
    expect(beginUndo).toHaveBeenCalledTimes(1);

    window.dispatchEvent(ptr('pointermove', 500, 90)); // +200px → +50% → 100%
    expect(applyGeom).toHaveBeenLastCalledWith(
      expect.objectContaining({ widthPct: 100, align: 'stretch' }),
      false,
    );

    window.dispatchEvent(ptr('pointerup', 500, 90));
    expect(recordGeomDiff).toHaveBeenCalledTimes(1);
    // after pointerup, further moves are ignored
    applyGeom.mockClear();
    window.dispatchEvent(ptr('pointermove', 600, 90));
    expect(applyGeom).not.toHaveBeenCalled();
  });

  it('width-left inverts the delta sign', () => {
    const { api, applyGeom } = setup();
    api.startHandle('width-left', ptr('pointerdown', 300, 90));
    window.dispatchEvent(ptr('pointermove', 500, 90)); // +200px but inverted → narrower
    expect(applyGeom.mock.lastCall?.[0].widthPct).toBeLessThan(50);
    window.dispatchEvent(ptr('pointerup', 500, 90));
  });

  it('dragLabel reflects the active handle and its value', () => {
    const { api } = setup({ ...DEFAULT_GEOM, widthPct: 50, align: 'left', marginTop: 7 });
    expect(api.dragLabel.value).toBeNull();
    api.startHandle('mt', ptr('pointerdown', 200, 50));
    expect(api.dragLabel.value).toMatchObject({ text: '上 7mm' });
    window.dispatchEvent(ptr('pointerup', 200, 50));
    expect(api.dragLabel.value).toBeNull();
  });
});
