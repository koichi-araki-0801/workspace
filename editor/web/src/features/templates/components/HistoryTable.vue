<script setup lang="ts" generic="T extends { id: string }">
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Column definition for a history table: a header plus a text accessor for each row. */
export interface HistoryColumn<Row> {
  header: string;
  cellClass?: string;
  value: (row: Row) => string;
}

defineProps<{
  columns: HistoryColumn<T>[];
  /** The currently visible (paged) rows. */
  rows: readonly T[];
  /** True when there are no rows after filtering (shows the "履歴なし" row). */
  empty: boolean;
  hasMore: boolean;
  remaining: number;
  loading: boolean;
}>();

const emit = defineEmits<{ loadMore: [] }>();
</script>

<template>
  <div class="rounded-lg border bg-card">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead v-for="col in columns" :key="col.header">{{ col.header }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-if="loading">
          <TableCell :colspan="columns.length" class="py-8 text-center text-muted-foreground">読み込み中…</TableCell>
        </TableRow>
        <template v-else>
          <TableRow v-for="row in rows" :key="row.id">
            <TableCell v-for="col in columns" :key="col.header" :class="col.cellClass">{{ col.value(row) }}</TableCell>
          </TableRow>
          <TableRow v-if="empty">
            <TableCell :colspan="columns.length" class="py-8 text-center text-muted-foreground">履歴なし</TableCell>
          </TableRow>
          <TableRow v-if="hasMore">
            <TableCell :colspan="columns.length" class="py-3 text-center">
              <Button variant="outline" size="sm" @click="emit('loadMore')">さらに表示（残り{{ remaining }}件）</Button>
            </TableCell>
          </TableRow>
        </template>
      </TableBody>
    </Table>
  </div>
</template>
