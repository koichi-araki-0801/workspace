import grapesjs, { type Component, type Editor } from 'grapesjs';
import { ref, shallowRef } from 'vue';
import 'grapesjs/dist/css/grapes.min.css';
import { jinjaChipCanvasCss, registerJinjaComponents } from './jinjaComponents';

export interface GrapesContainers {
  canvas: HTMLElement;
  layers: HTMLElement;
}

export interface SelectedInfo {
  id: string;
  name: string;
  isJinja: boolean;
  /** Catalog part id, if the component was inserted from the parts catalog. */
  partId?: string;
}

export function useGrapes() {
  const editor = shallowRef<Editor>();
  const selected = ref<SelectedInfo | null>(null);
  let changeCb: (() => void) | null = null;

  function init(c: GrapesContainers): Editor {
    const ed = grapesjs.init({
      container: c.canvas,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      // Style/Trait/Selector managers are intentionally left unmounted (no
      // appendTo): the right pane shows read-only part properties instead.
      selectorManager: { componentFirst: true },
      layerManager: { appendTo: c.layers },
      assetManager: { custom: true },
    });

    registerJinjaComponents(ed);

    ed.on('load', () => {
      const docu = ed.Canvas.getDocument();
      if (docu) {
        const styleEl = docu.createElement('style');
        styleEl.textContent = jinjaChipCanvasCss;
        docu.head.appendChild(styleEl);
      }
    });

    ed.on('component:selected', () => {
      const comp = ed.getSelected();
      selected.value = comp ? toInfo(comp) : null;
    });
    ed.on('component:deselected', () => {
      selected.value = null;
    });

    const fireChange = () => changeCb?.();
    ed.on('component:update', fireChange);
    ed.on('component:add', fireChange);
    ed.on('component:remove', fireChange);
    ed.on('style:update', fireChange);

    editor.value = ed;
    return ed;
  }

  function toInfo(comp: Component): SelectedInfo {
    const type = comp.get('type') ?? '';
    const partId = comp.getAttributes()['data-part-id'];
    return {
      id: comp.getId(),
      name: (comp.get('name') as string) || comp.get('tagName') || 'element',
      isJinja: typeof type === 'string' && type.startsWith('jinja-'),
      partId: typeof partId === 'string' ? partId : undefined,
    };
  }

  /** Insert a catalog part's HTML after the current selection (or at the end). */
  function insertPart(content: string, partId: string): void {
    const ed = editor.value;
    if (!ed) return;
    const sel = ed.getSelected();
    const parent = sel?.parent();
    const added =
      parent && sel
        ? parent.append(content, { at: sel.index() + 1 })
        : ed.getWrapper()?.append(content);
    const root = Array.isArray(added) ? added[0] : added;
    // tag with the catalog id so a later canvas selection resolves back to docs
    root?.addAttributes?.({ 'data-part-id': partId });
  }

  function load(bodyEditableHtml: string, css: string): void {
    const ed = editor.value;
    if (!ed) return;
    ed.setComponents(bodyEditableHtml);
    ed.setStyle(css);
  }

  function getBodyHtml(): string {
    return editor.value?.getHtml() ?? '';
  }

  function getCss(): string {
    return editor.value?.getCss() ?? '';
  }

  function onChange(cb: () => void): void {
    changeCb = cb;
  }

  function destroy(): void {
    editor.value?.destroy();
    editor.value = undefined;
  }

  return { editor, selected, init, load, insertPart, getBodyHtml, getCss, onChange, destroy };
}
