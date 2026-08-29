// =============================================================================
// table.ts — テーブル部品群(`<thead>`/`<tbody>`/`<tr>`/`<th>`/`<td>`)の定義
// =============================================================================
// 単純な 5 部品は `styledTag` ファクトリで生成し、`Table` のみ scroll コンテナ
// 入れ子のため個別定義する。
import { cva } from 'class-variance-authority';
import { defineComponent, h } from 'vue';
import { cn } from '@/lib/utils';

// 空行/ローディング/「該当なし」など、本文が無いとき全列に渡す中央寄せメッセージセル。
// 各一覧テーブルで重複していた `py-N text-center text-muted-foreground` を集約する。
// `pad` は行高の差 (一覧で `lg`=`py-10`, 履歴/管理で既定=`py-8`) を温存するための variant。
export const tableMessageCell = cva('text-center text-muted-foreground', {
  variants: { pad: { default: 'py-8', lg: 'py-10' } },
  defaultVariants: { pad: 'default' },
});

/**
 * 単一要素のスタイル付きラッパを定義する。`base` クラスと任意の `class` prop を
 * `cn` でマージして `<tag>` を描画し、slot の子要素をそのまま通す。単純な 5 つの
 * テーブル部品は同じ形なのでこのファクトリから生成する(`Table` 自身は scroll
 * コンテナの中に `<table>` を入れ子にする bespoke な構造)。
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
