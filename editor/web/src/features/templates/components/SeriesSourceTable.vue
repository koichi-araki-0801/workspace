<script setup lang="ts">
// =============================================================================
// SeriesSourceTable.vue — シリーズから作成のコピー元候補(テンプレが無い行は作成できない)
// =============================================================================
// コピー元は同じシリーズの他のファンド。生成器はコピー元のテンプレート(templates/)を読むので、
// それが無いファンドは警告を出して作成ボタンを押せなくする(サーバ側も 400 で止める)。
import type { SeriesFundOption } from '@editor/shared';
import { FilePlus2, TriangleAlert } from '@lucide/vue';
import Button from '@/components/ui/Button.vue';
import TableContainer from '@/components/ui/TableContainer.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const props = defineProps<{ rows: SeriesFundOption[]; disabled?: boolean }>();
const emit = defineEmits<{ create: [string] }>();
</script>

<template>
  <TableContainer>
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-[120px]">ファンドコード</TableHead>
          <TableHead class="w-[360px]">ファンド名</TableHead>
          <TableHead class="w-[260px]">状態</TableHead>
          <TableHead class="w-[120px] text-center">作成</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody class="[&>tr:nth-child(even)]:bg-muted/40">
        <TableRow v-for="row in props.rows" :key="row.fundCode">
          <TableCell class="mono truncate font-medium">{{ row.fundCode }}</TableCell>
          <TableCell class="truncate">{{ row.fundName }}</TableCell>
          <TableCell>
            <span
              v-if="!row.hasTemplate"
              class="inline-flex items-center gap-1 text-xs text-destructive"
            >
              <TriangleAlert class="h-3.5 w-3.5" /> コピー元のテンプレートがありません
            </span>
            <span v-else class="text-muted-foreground">—</span>
          </TableCell>
          <TableCell class="text-center">
            <Button
              :data-testid="`series-create-${row.fundCode}`"
              size="sm"
              variant="outline"
              :disabled="props.disabled || !row.hasTemplate"
              @click="emit('create', row.fundCode)"
            >
              <FilePlus2 class="h-4 w-4" />
              作成
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </TableContainer>
</template>
