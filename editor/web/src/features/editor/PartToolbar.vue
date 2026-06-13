<script setup lang="ts">
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  GripVertical,
  RotateCcw,
  SplitSquareVertical,
  Trash2,
} from '@lucide/vue';
import { reactive, watch } from 'vue';
import { cn } from '@/lib/utils';
import type { Align, LayoutGeom } from './geom';

const props = defineProps<{
  geom: LayoutGeom;
  editMode: boolean;
  canUp: boolean;
  canDown: boolean;
}>();

const emit = defineEmits<{
  apply: [Partial<LayoutGeom>];
  move: [-1 | 1];
  movestart: [MouseEvent];
  reset: [];
  del: [];
}>();

// Editable mirrors of the numeric fields (kept in sync with the live geometry).
const num = reactive({ widthPct: '100', marginTop: '0', marginBottom: '0' });
watch(
  () => props.geom,
  (g) => {
    num.widthPct = String(g.widthPct);
    num.marginTop = String(g.marginTop);
    num.marginBottom = String(g.marginBottom);
  },
  { immediate: true, deep: true },
);

const canAlign = () => props.geom.widthPct < 100;

function setAlign(align: Align) {
  if (canAlign()) emit('apply', { align });
}

function onEnter(e: KeyboardEvent) {
  (e.target as HTMLInputElement).blur();
}

function commitNum(key: 'widthPct' | 'marginTop' | 'marginBottom', raw: string) {
  let n = Math.round(Number(raw));
  if (Number.isNaN(n)) n = props.geom[key];
  const [min, max] = key === 'widthPct' ? [20, 100] : [0, 60];
  n = Math.max(min, Math.min(max, n));
  num[key] = String(n);
  if (key === 'widthPct') {
    emit('apply', { widthPct: n, align: n >= 100 ? 'stretch' : props.geom.align === 'stretch' ? 'left' : props.geom.align });
  } else {
    emit('apply', { [key]: n } as Partial<LayoutGeom>);
  }
}
</script>

<template>
  <div
    class="flex items-center gap-0.5 rounded-[11px] border bg-card p-1 shadow-[var(--shadow-md)]"
    @mousedown.stop
    @click.stop
  >
    <!-- drag to reorder (native sorter) -->
    <button type="button" class="ret-tb ret-grip" title="ドラッグで移動" @mousedown="emit('movestart', $event)">
      <GripVertical class="h-[15px] w-[15px]" />
    </button>
    <span class="mx-0.5 h-5 w-px bg-border" />

    <!-- reorder -->
    <button type="button" class="ret-tb" title="上へ移動" :disabled="!canUp" @click="emit('move', -1)">
      <ChevronUp class="h-[15px] w-[15px]" />
    </button>
    <button type="button" class="ret-tb" title="下へ移動" :disabled="!canDown" @click="emit('move', 1)">
      <ChevronDown class="h-[15px] w-[15px]" />
    </button>
    <span class="mx-0.5 h-5 w-px bg-border" />

    <!-- alignment -->
    <button type="button" class="ret-tb" title="左寄せ" :disabled="!canAlign()" :class="cn(canAlign() && geom.align === 'left' && 'ret-tb-on')" @click="setAlign('left')">
      <AlignLeft class="h-[15px] w-[15px]" />
    </button>
    <button type="button" class="ret-tb" title="中央" :disabled="!canAlign()" :class="cn(canAlign() && geom.align === 'center' && 'ret-tb-on')" @click="setAlign('center')">
      <AlignCenter class="h-[15px] w-[15px]" />
    </button>
    <button type="button" class="ret-tb" title="右寄せ" :disabled="!canAlign()" :class="cn(canAlign() && geom.align === 'right' && 'ret-tb-on')" @click="setAlign('right')">
      <AlignRight class="h-[15px] w-[15px]" />
    </button>
    <span class="mx-0.5 h-5 w-px bg-border" />

    <!-- numeric: width / top / bottom -->
    <label class="ret-num" title="幅">
      <span>幅</span>
      <input v-model="num.widthPct" inputmode="numeric" class="mono" @blur="commitNum('widthPct', num.widthPct)" @keydown.enter="onEnter" />
      <span class="ret-unit">%</span>
    </label>
    <label class="ret-num" title="上の余白">
      <span>上</span>
      <input v-model="num.marginTop" inputmode="numeric" class="mono" @blur="commitNum('marginTop', num.marginTop)" @keydown.enter="onEnter" />
      <span class="ret-unit">mm</span>
    </label>
    <label class="ret-num" title="下の余白">
      <span>下</span>
      <input v-model="num.marginBottom" inputmode="numeric" class="mono" @blur="commitNum('marginBottom', num.marginBottom)" @keydown.enter="onEnter" />
      <span class="ret-unit">mm</span>
    </label>
    <span class="mx-0.5 h-5 w-px bg-border" />

    <!-- page breaks -->
    <button type="button" class="ret-tb" title="前で改ページ" :class="cn(geom.pageBreakBefore && 'ret-tb-on')" @click="emit('apply', { pageBreakBefore: !geom.pageBreakBefore })">
      <ArrowUpToLine class="h-[15px] w-[15px]" />
    </button>
    <button type="button" class="ret-tb" title="後で改ページ" :class="cn(geom.pageBreakAfter && 'ret-tb-on')" @click="emit('apply', { pageBreakAfter: !geom.pageBreakAfter })">
      <ArrowDownToLine class="h-[15px] w-[15px]" />
    </button>
    <button type="button" class="ret-tb" title="ページ内で分割しない" :class="cn(geom.keepTogether && 'ret-tb-on')" @click="emit('apply', { keepTogether: !geom.keepTogether })">
      <SplitSquareVertical class="h-[15px] w-[15px]" />
    </button>
    <span class="mx-0.5 h-5 w-px bg-border" />

    <!-- reset / delete -->
    <button type="button" class="ret-tb" title="配置を初期化" @click="emit('reset')">
      <RotateCcw class="h-[14px] w-[14px]" />
    </button>
    <button v-if="editMode" type="button" class="ret-tb ret-tb-danger" title="このパーツを削除" @click="emit('del')">
      <Trash2 class="h-[14px] w-[14px]" />
    </button>
  </div>
</template>

<style scoped>
.ret-tb {
  display: inline-flex;
  height: 30px;
  min-width: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  padding: 0 6px;
  color: hsl(var(--foreground) / 0.8);
  transition: background-color 0.12s;
}
.ret-tb:hover:not(:disabled) {
  background: hsl(var(--accent));
}
.ret-tb:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ret-tb-on {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}
.ret-tb-on:hover {
  background: hsl(var(--primary));
}
.ret-grip {
  cursor: grab;
}
.ret-grip:active {
  cursor: grabbing;
}
.ret-tb-danger {
  color: hsl(var(--destructive));
}
.ret-tb-danger:hover {
  background: hsl(var(--destructive) / 0.12);
}
.ret-num {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 3px;
  border-radius: 7px;
  background: hsl(var(--muted));
  padding: 0 6px;
  font-size: 11px;
  font-weight: 700;
  color: hsl(var(--muted-foreground));
}
.ret-num input {
  width: 26px;
  border: 0;
  background: transparent;
  text-align: center;
  font-size: 12.5px;
  font-weight: 600;
  color: hsl(var(--foreground));
  outline: none;
  padding: 0;
}
.ret-unit {
  font-size: 10px;
  color: hsl(var(--muted-foreground));
}
</style>
