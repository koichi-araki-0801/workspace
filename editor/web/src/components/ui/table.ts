import { defineComponent, h } from 'vue';
import { cn } from '@/lib/utils';

/**
 * Define a single-element styled wrapper: renders `<tag>` with `base` classes
 * merged with an optional `class` prop, passing slot children through. The five
 * simple table parts share this exact shape, so they are built from this factory
 * (Table itself is bespoke — it nests `<table>` inside a scroll container).
 */
function styledTag(name: string, tag: string, base: string) {
  return defineComponent({
    name,
    props: { class: { type: String, default: undefined } },
    setup(props, { slots }) {
      return () => h(tag, { class: cn(base, props.class) }, slots.default?.());
    },
  });
}

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

export const TableHeader = styledTag('TableHeader', 'thead', '[&_tr]:border-b bg-muted/60');

export const TableBody = styledTag('TableBody', 'tbody', '[&_tr:last-child]:border-0');

export const TableRow = styledTag(
  'TableRow',
  'tr',
  'border-b transition-colors duration-150 hover:bg-accent/50 data-[state=selected]:bg-muted',
);

export const TableHead = styledTag(
  'TableHead',
  'th',
  'h-10 px-3 text-left align-middle text-xs font-semibold text-muted-foreground [&:has([role=checkbox])]:pr-0',
);

export const TableCell = styledTag(
  'TableCell',
  'td',
  'p-3 align-middle [&:has([role=checkbox])]:pr-0',
);
