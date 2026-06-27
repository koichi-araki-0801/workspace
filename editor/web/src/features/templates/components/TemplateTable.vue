<script setup lang="ts">
// =============================================================================
// TemplateTable.vue — テンプレ一覧テーブル (編集/作成の action 列つき)
// =============================================================================
import type { TemplateMeta } from '@editor/shared';
import { FilePlus2, Inbox, Pencil } from '@lucide/vue';
import { computed } from 'vue';
import FundCodeName from '@/components/FundCodeName.vue';
import Button from '@/components/ui/Button.vue';
import TableContainer from '@/components/ui/TableContainer.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableMessageCell } from '@/components/ui/table';
import { toTemplateMetaVm } from '../viewmodels/templateVm';

const props = withDefaults(
  defineProps<{
    rows: TemplateMeta[];
    /** action 列のラベル: 編集 (edit) または 作成 (create)。 */
    action?: 'edit' | 'create';
    showBaseDate?: boolean;
    /** 版数 (確定保存回数)。編集タブでは「状態」列の代わりに版数を表示する。 */
    versionCounts?: Record<string, number>;
  }>(),
  { action: 'edit', showBaseDate: true },
);

const emit = defineEmits<{ action: [TemplateMeta] }>();

const vms = computed(() => props.rows.map(toTemplateMetaVm));

// 版数列は編集タブのみ。シリーズ候補 (create) は状態も版数も出さない。
const showVersion = computed(() => props.action === 'edit');
const emptyColspan = computed(
  () => 4 + (props.showBaseDate ? 1 : 0) + (showVersion.value ? 1 : 0),
);
</script>

<template>
  <TableContainer>
    <Table class="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead class="w-[110px]">委託会社コード</TableHead>
          <TableHead class="w-[360px]">ファンド</TableHead>
          <TableHead v-if="showBaseDate" class="w-[120px]">基準日</TableHead>
          <TableHead class="w-[88px]">版種</TableHead>
          <TableHead v-if="showVersion" class="w-[100px] text-center">版数</TableHead>
          <TableHead class="w-[120px] text-center">{{ action === 'edit' ? '編集' : '作成' }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody class="[&>tr:nth-child(even)]:bg-muted/40">
        <TableRow v-for="vm in vms" :key="vm.id">
          <TableCell class="mono truncate font-medium">{{ vm.attributes.companyCode }}</TableCell>
          <TableCell class="truncate">
            <FundCodeName :code="vm.attributes.fundCode" />
          </TableCell>
          <TableCell v-if="showBaseDate" class="mono truncate">{{ vm.attributes.baseDate }}</TableCell>
          <TableCell class="truncate">{{ vm.attributes.editionType }}</TableCell>
          <TableCell v-if="showVersion" class="text-center">
            <span class="font-medium">{{ versionCounts?.[vm.id] ?? 0 }}版</span>
          </TableCell>
          <TableCell class="text-center">
            <Button size="sm" :variant="action === 'edit' ? 'default' : 'outline'" @click="emit('action', vm.raw)">
              <component :is="action === 'edit' ? Pencil : FilePlus2" class="h-4 w-4" />
              {{ action === 'edit' ? '編集' : '作成' }}
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="rows.length === 0">
          <TableCell :colspan="emptyColspan" :class="tableMessageCell({ pad: 'lg' })">
            <div class="flex flex-col items-center gap-2">
              <Inbox class="h-8 w-8 opacity-40" />
              <span>該当するテンプレートがありません</span>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </TableContainer>
</template>
