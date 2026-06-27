<script setup lang="ts">
// =============================================================================
// CompareCandidateTable.vue — 比較候補テンプレートの一覧テーブル(選択UI)
// =============================================================================
import { Check, ChevronLeft, ChevronRight, Inbox } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import FundCodeName from '@/components/FundCodeName.vue';
import Button from '@/components/ui/Button.vue';
import TableContainer from '@/components/ui/TableContainer.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableMessageCell } from '@/components/ui/table';
import { versionLabel } from '@/lib/format';
import type { CompareVersionRow } from './services/compareService';

const props = withDefaults(
  defineProps<{
    /** テンプレート × 版に平坦化済みの行。テンプレートが複数版を持てば複数行になる。 */
    rows: CompareVersionRow[];
    /** 現在選択中の版の `historyId`(行ハイライト用)。 */
    selectedId?: string;
    /** 1 ページの最大行数。これを超えたら前へ/次へでページ送りする。 */
    pageSize?: number;
  }>(),
  { pageSize: 5 },
);

const emit = defineEmits<{ select: [CompareVersionRow] }>();

// ── ページ送り(オフセット式) ──
// 累積式の `usePagedList` は「ページ送り」要件に合わないため、当該ページ分だけを
// 切り出す軽量実装をここに閉じる。`rows` が差し替わる(再絞り込み)たびに先頭へ戻す。
const currentPage = ref(1);
const totalPages = computed(() => Math.max(1, Math.ceil(props.rows.length / props.pageSize)));
const pagedRows = computed(() =>
  props.rows.slice((currentPage.value - 1) * props.pageSize, currentPage.value * props.pageSize),
);
watch(
  () => props.rows,
  () => {
    currentPage.value = 1;
  },
);
</script>

<template>
  <TableContainer>
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-[104px]">委託会社コード</TableHead>
          <TableHead class="w-[260px]">ファンド</TableHead>
          <TableHead class="w-[110px]">基準日</TableHead>
          <TableHead class="w-[84px]">版種</TableHead>
          <TableHead class="w-[180px]">版</TableHead>
          <TableHead class="w-[96px] text-center">選択</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <!-- 選択中の行は明確にハイライトする。`bg-primary-soft` 単独はライトモード(白い
             カード)上でほぼ不可視のため、不透明度修飾の淡青 + 左端アクセント罫で視認可能に
             する。 -->
        <TableRow
          v-for="c in pagedRows"
          :key="c.version.historyId"
          :class="c.version.historyId === props.selectedId
            ? 'bg-primary/10 [&>td:first-child]:border-l-2 [&>td:first-child]:border-primary'
            : ''"
        >
          <TableCell class="mono truncate font-medium">{{ c.meta.attributes.companyCode }}</TableCell>
          <TableCell class="truncate">
            <FundCodeName :code="c.meta.attributes.fundCode" />
          </TableCell>
          <TableCell class="mono truncate">{{ c.meta.attributes.baseDate }}</TableCell>
          <TableCell class="truncate">{{ c.meta.attributes.editionType }}</TableCell>
          <TableCell class="truncate">{{ versionLabel(c.version) }}</TableCell>
          <TableCell class="text-center">
            <!-- 押下のフィードバックを明示する。選択中の行は塗りつぶし(default)+「選択中」で
                 既選択が一目で分かる。再クリック/別行選択は妨げないため click は両状態で維持。 -->
            <Button
              size="sm"
              :variant="c.version.historyId === props.selectedId ? 'default' : 'outline'"
              @click="emit('select', c)"
            >
              <Check class="h-4 w-4" />
              {{ c.version.historyId === props.selectedId ? '選択中' : '選択' }}
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="props.rows.length === 0">
          <TableCell :colspan="6" :class="tableMessageCell({ pad: 'lg' })">
            <div class="flex flex-col items-center gap-2">
              <Inbox class="h-8 w-8 opacity-40" />
              <span>該当するテンプレートがありません</span>
            </div>
          </TableCell>
        </TableRow>
        <!-- 1 ページに収まらない時だけページ送りフッタを出す。 -->
        <TableRow v-if="props.rows.length > props.pageSize">
          <TableCell :colspan="6" class="py-2">
            <div class="flex items-center justify-center gap-3 text-[13px]">
              <Button
                size="sm"
                variant="outline"
                :disabled="currentPage <= 1"
                @click="currentPage--"
              >
                <ChevronLeft class="h-4 w-4" /> 前へ
              </Button>
              <span class="text-muted-foreground">{{ currentPage }} / {{ totalPages }} ページ</span>
              <Button
                size="sm"
                variant="outline"
                :disabled="currentPage >= totalPages"
                @click="currentPage++"
              >
                次へ <ChevronRight class="h-4 w-4" />
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </TableContainer>
</template>
