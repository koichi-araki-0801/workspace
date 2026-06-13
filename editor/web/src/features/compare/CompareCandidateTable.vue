<script setup lang="ts">
import type { TemplateMeta } from '@editor/shared';
import { Check, Inbox } from '@lucide/vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompareCandidate } from './services/compareService';

const props = defineProps<{
  rows: CompareCandidate[];
  /** id of the currently picked template (row highlight). */
  selectedId?: string;
}>();

const emit = defineEmits<{ select: [TemplateMeta] }>();

// 比較には確定保存が2回以上（＝2版以上）必要。
const comparable = (c: CompareCandidate) => c.versionCount >= 2;
</script>

<template>
  <div class="rounded-lg border bg-card">
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-[150px]">委託会社コード</TableHead>
          <TableHead class="w-[130px]">ファンドコード</TableHead>
          <TableHead class="w-[120px]">基準日</TableHead>
          <TableHead>版種</TableHead>
          <TableHead class="w-[100px]">状態</TableHead>
          <TableHead class="w-[80px]">版数</TableHead>
          <TableHead class="w-[110px] text-right">選択</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="c in props.rows"
          :key="c.meta.id"
          :class="c.meta.id === props.selectedId ? 'bg-primary-soft' : ''"
        >
          <TableCell class="mono truncate font-medium">{{ c.meta.attributes.companyCode }}</TableCell>
          <TableCell class="mono truncate">{{ c.meta.attributes.fundCode }}</TableCell>
          <TableCell class="mono truncate">{{ c.meta.attributes.baseDate }}</TableCell>
          <TableCell class="truncate">{{ c.meta.attributes.editionType }}</TableCell>
          <TableCell>
            <Badge :variant="c.meta.status === 'published' ? 'success' : 'secondary'">
              {{ c.meta.status === 'published' ? '確定済' : '下書き' }}
            </Badge>
          </TableCell>
          <TableCell>
            <span class="font-medium">{{ c.versionCount }}版</span>
          </TableCell>
          <TableCell class="text-right">
            <Button
              size="sm"
              variant="outline"
              :disabled="!comparable(c)"
              :title="comparable(c) ? '' : '比較には確定保存が2回以上（2版以上）必要です'"
              @click="emit('select', c.meta)"
            >
              <Check class="h-4 w-4" /> 選択
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="props.rows.length === 0">
          <TableCell :colspan="7" class="py-10 text-center text-muted-foreground">
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
