// =============================================================================
// tabs.ts — `reka-ui` の Tabs プリミティブにスタイルを被せた薄いラッパ群
// =============================================================================
// `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` を Tailwind クラス込みで再エクスポート
// する。`modelValue` は `TabsRoot` へ素通しし、`update:modelValue` を再 emit する。
import {
  TabsContent as RekaTabsContent,
  TabsList as RekaTabsList,
  TabsTrigger as RekaTabsTrigger,
  TabsRoot,
} from 'reka-ui';
import { defineComponent, h } from 'vue';
import { cn } from '@/lib/utils';

export const Tabs = defineComponent({
  name: 'Tabs',
  props: {
    class: { type: String, default: undefined },
    modelValue: { type: String, default: undefined },
  },
  emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        TabsRoot,
        {
          modelValue: props.modelValue,
          'onUpdate:modelValue': (value: string | number) => emit('update:modelValue', value),
          class: props.class,
        },
        () => slots.default?.(),
      );
  },
});

export const TabsList = defineComponent({
  name: 'TabsList',
  props: { class: { type: String, default: undefined } },
  setup(props, { slots }) {
    return () =>
      h(
        RekaTabsList,
        {
          class: cn(
            'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
            props.class,
          ),
        },
        () => slots.default?.(),
      );
  },
});

export const TabsTrigger = defineComponent({
  name: 'TabsTrigger',
  props: {
    value: { type: String, required: true },
    class: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        RekaTabsTrigger,
        {
          value: props.value,
          class: cn(
            'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
            props.class,
          ),
        },
        () => slots.default?.(),
      );
  },
});

export const TabsContent = defineComponent({
  name: 'TabsContent',
  props: {
    value: { type: String, required: true },
    class: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(
        RekaTabsContent,
        {
          value: props.value,
          class: cn('mt-2 ring-offset-background focus-visible:outline-none', props.class),
        },
        () => slots.default?.(),
      );
  },
});
