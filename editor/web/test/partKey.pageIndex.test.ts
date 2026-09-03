import { describe, expect, it } from 'vitest';
import { partLabelMap, partPageIndexMap } from '@/features/editor/partKey';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('partPageIndexMap', () => {
  it('partLabelMap と同じキーで 0 始まりのページ index を返す', () => {
    const r = root(
      '<div class="page"><h1 id="cover"></h1><p></p></div><div class="page"><table></table></div>',
    );
    const labels = partLabelMap(r);
    const pages = partPageIndexMap(r);
    expect([...pages.keys()]).toEqual([...labels.keys()]);
    expect([...pages.values()]).toEqual([0, 0, 1]);
  });
});
