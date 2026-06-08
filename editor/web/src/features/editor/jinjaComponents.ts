import type { Editor } from 'grapesjs';

/**
 * Register the locked Jinja chip component types. The chips are produced by
 * `toEditable` as `<span data-gjs-type="jinja-var|stmt|comment" data-jinja="…">`.
 * GrapesJS auto-assigns the type from `data-gjs-type`; here we make them
 * non-editable, keep their `data-jinja` source attribute, and label them.
 */
export function registerJinjaComponents(editor: Editor): void {
  const dc = editor.DomComponents;

  const common = {
    editable: false,
    droppable: false,
    badgable: true,
    highlightable: true,
    // keep the data-jinja source attribute through edits/export
    attributes: {},
  };

  dc.addType('jinja-var', {
    model: {
      defaults: {
        ...common,
        name: '差し込み（値）',
        draggable: true,
        removable: true,
      },
    },
  });

  dc.addType('jinja-stmt', {
    model: {
      defaults: {
        ...common,
        name: '条件・繰り返し',
        draggable: false,
        removable: false,
        copyable: false,
      },
    },
  });

  dc.addType('jinja-comment', {
    model: {
      defaults: {
        ...common,
        name: 'メモ',
        draggable: true,
        removable: true,
      },
    },
  });
}

/** CSS injected into the GrapesJS canvas to visualise locked Jinja chips. */
export const jinjaChipCanvasCss = `
.jinja-chip {
  display: inline-block;
  padding: 0 4px;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
.jinja-chip.jinja-var { background: #dbeafe; color: #1e40af; border: 1px solid #93c5fd; }
.jinja-chip.jinja-stmt { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
.jinja-chip.jinja-comment { background: #e5e7eb; color: #6b7280; border: 1px dashed #9ca3af; }
[data-jinja-open] { outline: 1px dashed #f59e0b; outline-offset: 2px; }
`;
