import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { DEFAULT_GEOM, type LayoutGeom } from '@/features/editor/geom';
import type { SelectedRect } from '@/features/editor/grapesEvents';
import { useGeomHandles } from '@/features/editor/useGeomHandles';

function setup(geom: LayoutGeom = { ...DEFAULT_GEOM, widthPct: 50, align: 'left' }) {
  const selectedGeom = computed(() => geom);
  const selectedRect = ref<SelectedRect | null>({ left: 100, top: 50, width: 200, height: 80 });
  const zoom = ref(1);
  const beginUndo = vi.fn();
  const applyGeom = vi.fn();
  const recordGeomDiff = vi.fn();
  const api = useGeomHandles({
    selectedGeom,
    selectedRect,
    zoom,
    beginUndo,
    applyGeom,
    recordGeomDiff,
  });
  return { api, beginUndo, applyGeom, recordGeomDiff };
}

const mouse = (type: string, x: number, y: number) =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });

describe('useGeomHandles', () => {
  it('width drag: begins one undo, live-applies width without recording, logs diff on mouseup', () => {
    const { api, beginUndo, applyGeom, recordGeomDiff } = setup();
    // fullW = width / (widthPct/100) = 200 / 0.5 = 400px for 100%.
    api.startHandle('width', mouse('mousedown', 300, 90));
    expect(beginUndo).toHaveBeenCalledTimes(1);

    window.dispatchEvent(mouse('mousemove', 500, 90)); // +200px → +50% → 100%
    expect(applyGeom).toHaveBeenLastCalledWith(
      expect.objectContaining({ widthPct: 100, align: 'stretch' }),
      false,
    );

    window.dispatchEvent(mouse('mouseup', 500, 90));
    expect(recordGeomDiff).toHaveBeenCalledTimes(1);
    // after mouseup, further moves are ignored
    applyGeom.mockClear();
    window.dispatchEvent(mouse('mousemove', 600, 90));
    expect(applyGeom).not.toHaveBeenCalled();
  });

  it('width-left inverts the delta sign', () => {
    const { api, applyGeom } = setup();
    api.startHandle('width-left', mouse('mousedown', 300, 90));
    window.dispatchEvent(mouse('mousemove', 500, 90)); // +200px but inverted → narrower
    expect(applyGeom.mock.lastCall?.[0].widthPct).toBeLessThan(50);
    window.dispatchEvent(mouse('mouseup', 500, 90));
  });

  it('dragLabel reflects the active handle and its value', () => {
    const { api } = setup({ ...DEFAULT_GEOM, widthPct: 50, align: 'left', marginTop: 7 });
    expect(api.dragLabel.value).toBeNull();
    api.startHandle('mt', mouse('mousedown', 200, 50));
    expect(api.dragLabel.value).toMatchObject({ text: '上 7mm' });
    window.dispatchEvent(mouse('mouseup', 200, 50));
    expect(api.dragLabel.value).toBeNull();
  });
});
