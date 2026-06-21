<script setup lang="ts" generic="T extends { id: string }">
// =============================================================================
// HistoryTable.vue — 履歴フィードの汎用テーブル (列定義+ページング行)
// =============================================================================
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** 履歴テーブルの列定義。header と、各行のテキスト accessor を持つ。 */
export interface HistoryColumn<Row> {
  header: string;
  /** body セルに適用する class (例 `mono`)。 */
  cellClass?: string;
  /** header セルに適用する class。固定幅をここに置きタブ間で列を揃える。 */
  headerClass?: string;
  value: (row: Row) => string;
}

defineProps<{
  columns: HistoryColumn<T>[];
  /** 現在表示中の (ページング後の) 行。 */
  rows: readonly T[];
  /** フィルタ後に行が無いとき true (「履歴なし」行を出す)。 */
  empty: boolean;
  hasMore: boolean;
  remaining: number;
  loading: boolean;
}>();

const emit = defineEmits<{ loadMore: [] }>();
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-card">
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead v-for="col in columns" :key="col.header" :class="col.headerClass">{{ col.header }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody class="[&>tr:nth-child(even)]:bg-muted/40">
        <TableRow v-if="loading">
          <TableCell :colspan="columns.length" class="py-8 text-center text-muted-foreground">読み込み中…</TableCell>
        </TableRow>
        <template v-else>
          <TableRow v-for="row in rows" :key="row.id">
            <TableCell
              v-for="col in columns"
              :key="col.header"
              :class="col.cellClass ? `truncate ${col.cellClass}` : 'truncate'"
              :title="col.value(row)"
            >{{ col.value(row) }}</TableCell>
          </TableRow>
          <TableRow v-if="empty">
            <TableCell :colspan="columns.length" class="py-8 text-center text-muted-foreground">該当する履歴がありません。</TableCell>
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
