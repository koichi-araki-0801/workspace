<script setup lang="ts">
import type { TemplateMeta } from '@editor/shared';
import { Check, Inbox } from '@lucide/vue';
import { watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFundNames } from '@/lib/useFundNames';
import type { CompareCandidate } from './services/compareService';

const props = withDefaults(
  defineProps<{
    rows: CompareCandidate[];
    /** id of the currently picked template (row highlight). */
    selectedId?: string;
    /** 選択可能な最小版数。独立2選択（任意の2ファイル比較）では各側1版以上で可。 */
    minVersions?: number;
  }>(),
  { minVersions: 2 },
);

const emit = defineEmits<{ select: [TemplateMeta] }>();

const comparable = (c: CompareCandidate) => c.versionCount >= props.minVersions;

const { resolve, nameOf } = useFundNames();
watch(
  () => props.rows,
  (rows) => resolve(rows.map((c) => c.meta.attributes.fundCode)),
  { immediate: true },
);
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
            <span class="mono font-medium">{{ c.meta.attributes.fundCode }}</span>
            <span v-if="nameOf(c.meta.attributes.fundCode)" class="ml-2 text-sm text-muted-foreground">
              {{ nameOf(c.meta.attributes.fundCode) }}
            </span>
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
