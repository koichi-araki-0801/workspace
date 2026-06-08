import { defineComponent, h } from 'vue';
import { cn } from '@/lib/utils';

export const Table = defineComponent({
  name: 'Table',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'relative w-full overflow-auto' }, [
        h('table', { class: cn('w-full caption-bottom text-sm', props.class) }, slots.default?.()),
      ]);
  },
});

export const TableHeader = defineComponent({
  name: 'TableHeader',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h('thead', { class: cn('[&_tr]:border-b bg-muted/60', props.class) }, slots.default?.());
  },
});

export const TableBody = defineComponent({
  name: 'TableBody',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h('tbody', { class: cn('[&_tr:last-child]:border-0', props.class) }, slots.default?.());
  },
});

export const TableRow = defineComponent({
  name: 'TableRow',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h(
        'tr',
        {
          class: cn(
            'border-b transition-colors hover:bg-muted data-[state=selected]:bg-muted',
            props.class,
          ),
        },
        slots.default?.(),
      );
  },
});

export const TableHead = defineComponent({
  name: 'TableHead',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h(
        'th',
        {
          class: cn(
            'h-10 px-3 text-left align-middle text-xs font-semibold text-muted-foreground [&:has([role=checkbox])]:pr-0',
            props.class,
          ),
        },
        slots.default?.(),
      );
  },
});

export const TableCell = defineComponent({
  name: 'TableCell',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h(
        'td',
        { class: cn('p-3 align-middle [&:has([role=checkbox])]:pr-0', props.class) },
        slots.default?.(),
      );
  },
});
