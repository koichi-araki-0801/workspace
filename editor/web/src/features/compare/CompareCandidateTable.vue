<script setup lang="ts">
// =============================================================================
// CompareCandidateTable.vue — 比較候補テンプレートの一覧テーブル(選択UI)
// =============================================================================
import type { TemplateMeta } from '@editor/shared';
import { Check, Inbox } from '@lucide/vue';
import FundCodeName from '@/components/FundCodeName.vue';
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompareCandidate } from './services/compareService';

const props = withDefaults(
  defineProps<{
    rows: CompareCandidate[];
    /** 現在選択中テンプレートの `id`(行ハイライト用)。 */
    selectedId?: string;
    /** 選択可能な最小版数。独立2選択(任意の2ファイル比較)では各側1版以上で可。 */
    minVersions?: number;
  }>(),
  { minVersions: 2 },
);

const emit = defineEmits<{ select: [TemplateMeta] }>();

const comparable = (c: CompareCandidate) => c.versionCount >= props.minVersions;
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-card">
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-[104px]">委託会社コード</TableHead>
          <TableHead class="w-[300px]">ファンド</TableHead>
          <TableHead class="w-[110px]">基準日</TableHead>
          <TableHead class="w-[84px]">版種</TableHead>
          <TableHead class="w-[72px] text-center">版数</TableHead>
          <TableHead class="w-[96px] text-center">選択</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="c in props.rows"
          :key="c.meta.id"
          :class="c.meta.id === props.selectedId ? 'bg-primary-soft' : ''"
        >
          <TableCell class="mono truncate font-medium">{{ c.meta.attributes.companyCode }}</TableCell>
          <TableCell class="truncate">
            <FundCodeName :code="c.meta.attributes.fundCode" />
          </TableCell>
          <TableCell class="mono truncate">{{ c.meta.attributes.baseDate }}</TableCell>
          <TableCell class="truncate">{{ c.meta.attributes.editionType }}</TableCell>
          <TableCell class="text-center">
            <span class="font-medium">{{ c.versionCount }}版</span>
          </TableCell>
          <TableCell class="text-center">
            <Button
              size="sm"
              variant="outline"
              :disabled="!comparable(c)"
              :title="comparable(c) ? '' : `比較には確定保存が${props.minVersions}回以上（${props.minVersions}版以上）必要です`"
              @click="emit('select', c.meta)"
            >
              <Check class="h-4 w-4" /> 選択
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="props.rows.length === 0">
          <TableCell :colspan="6" class="py-10 text-center text-muted-foreground">
            <div class="flex flex-col items-center gap-2">
              <Inbox class="h-8 w-8 opacity-40" />
              <span>該当するテンプレートがありません</span>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
