<script setup lang="ts">
import type { PartCatalogItem, PartHistoryEntry } from '@editor/shared';
import { Eye, FileText, History, PanelRight, Table, TrendingUp, Wand2 } from '@lucide/vue';
import { computed } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import { formatDateTime } from '@/lib/format';
import { ALIGN_JP, type LayoutGeom } from './geom';
import type { SelectedInfo } from './useGrapes';

const props = defineProps<{
  selected: SelectedInfo | null;
  part: PartCatalogItem | null;
  geom: LayoutGeom | null;
  history: PartHistoryEntry[];
}>();

const label = computed(() => props.part?.name ?? props.selected?.name ?? '');
const group = computed(() => props.part?.classification.minorClass ?? props.selected?.name ?? '');
</script>

<template>
  <aside class="flex w-[312px] shrink-0 flex-col overflow-hidden border-l bg-card">
    <div class="flex h-[46px] shrink-0 items-center border-b px-4 text-[12.5px] font-bold">
      <span>プロパティ</span>
      <span class="flex-1" />
      <Badge v-if="selected" variant="secondary" class="h-[19px] gap-1 py-0">
        <Eye class="h-[11px] w-[11px]" /> 表示のみ
      </Badge>
    </div>

    <!-- empty -->
    <div
      v-if="!selected || !geom"
      class="grid flex-1 place-items-center px-6 text-center text-muted-foreground"
    >
      <div>
        <PanelRight class="mx-auto mb-2.5 h-[26px] w-[26px] opacity-40" />
        <p class="text-[13px] leading-relaxed">
          キャンバスでパーツを選ぶと、<br />現在の設定と修正履歴を表示します。
        </p>
      </div>
    </div>

    <template v-else>
      <!-- selected part identity -->
      <div class="border-b bg-primary-soft/50 px-4 py-3">
        <div class="text-sm font-bold text-foreground">{{ label }}</div>
        <div class="mt-0.5 text-[11.5px] text-muted-foreground">
          {{ group }} ・ <span class="mono">#{{ selected.id }}</span>
          <template v-if="selected.isJinja"> ・ <span class="text-warning-foreground">自動入力</span></template>
        </div>
      </div>

      <!-- adjust-on-canvas note -->
      <div class="flex items-start gap-2 border-b bg-muted/50 px-4 py-2.5">
        <Wand2 class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span class="text-[11.5px] leading-relaxed text-muted-foreground">
          調整は<b class="text-foreground">キャンバス上</b>で行います。ハンドルをドラッグ、または選択パーツのツールバーで操作してください。
        </span>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- size / placement -->
        <section class="border-b px-4 py-3">
          <div class="mb-1 flex items-center gap-1.5 text-[11.5px] font-bold tracking-wide text-muted-foreground">
            <Table class="h-3.5 w-3.5" /> サイズ・配置
          </div>
          <div class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">幅</span>
            <span class="mono font-semibold tabular-nums">{{ geom.widthPct }}%</span>
          </div>
          <div class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">横の配置</span>
            <span class="mono font-semibold" :class="geom.widthPct >= 100 ? 'text-muted-foreground' : ''">
              {{ geom.widthPct >= 100 ? '全幅' : ALIGN_JP[geom.align] }}
            </span>
          </div>
          <div class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">左インデント</span>
            <span class="mono font-semibold tabular-nums" :class="geom.indent === 0 ? 'text-muted-foreground' : ''">
              {{ geom.indent }} mm
            </span>
          </div>
        </section>

        <!-- margins -->
        <section class="border-b px-4 py-3">
          <div class="mb-1 flex items-center gap-1.5 text-[11.5px] font-bold tracking-wide text-muted-foreground">
            <TrendingUp class="h-3.5 w-3.5" /> 余白（前後の間隔）
          </div>
          <div class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">上の余白</span>
            <span class="mono font-semibold tabular-nums">{{ geom.marginTop }} mm</span>
          </div>
          <div class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">下の余白</span>
            <span class="mono font-semibold tabular-nums">{{ geom.marginBottom }} mm</span>
          </div>
        </section>

        <!-- page breaks -->
        <section class="border-b px-4 py-3">
          <div class="mb-1 flex items-center gap-1.5 text-[11.5px] font-bold tracking-wide text-muted-foreground">
            <FileText class="h-3.5 w-3.5" /> 改ページ
          </div>
          <div v-for="flag in [
            { label: '前で改ページ', on: geom.pageBreakBefore },
            { label: '後で改ページ', on: geom.pageBreakAfter },
            { label: 'ページ内で分割しない', on: geom.keepTogether },
          ]" :key="flag.label" class="flex items-center justify-between py-1.5 text-[12.5px]">
            <span class="text-muted-foreground">{{ flag.label }}</span>
            <span class="flex items-center gap-1.5 text-xs font-semibold" :class="flag.on ? 'text-success' : 'text-muted-foreground'">
              <span class="h-[7px] w-[7px] rounded-full" :class="flag.on ? 'bg-success' : 'bg-border'" />
              {{ flag.on ? 'ON' : 'OFF' }}
            </span>
          </div>
        </section>

        <!-- edit history -->
        <section class="px-4 py-3.5">
          <div class="mb-3 flex items-center gap-1.5 text-[11.5px] font-bold tracking-wide text-muted-foreground">
            <History class="h-3.5 w-3.5" /> 修正履歴
            <span class="flex-1" />
            <Badge variant="secondary" class="h-[18px] py-0 text-[10.5px]">{{ history.length }} 件</Badge>
          </div>
          <p v-if="history.length === 0" class="text-[12.5px] text-muted-foreground">変更履歴はまだありません。</p>
          <div v-else>
            <div
              v-for="(h, i) in history"
              :key="h.id"
              class="flex gap-2.5"
              :class="i < history.length - 1 ? 'pb-4' : ''"
            >
              <div class="flex flex-col items-center">
                <span class="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" :class="i === 0 ? 'bg-primary' : 'bg-border'" />
                <span v-if="i < history.length - 1" class="mt-0.5 w-0.5 flex-1 bg-border" />
              </div>
              <div class="flex-1">
                <div class="text-[12.5px] leading-snug text-foreground">{{ h.change }}</div>
                <div class="mt-0.5 text-[11px] text-muted-foreground">{{ formatDateTime(h.timestamp) }} ・ {{ h.user }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>
  </aside>
</template>
