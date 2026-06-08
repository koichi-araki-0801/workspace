<script setup lang="ts">
import type { TemplateMeta } from '@editor/shared';
import { FilePlus2, Inbox, Pencil } from 'lucide-vue-next';
import { computed } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toTemplateMetaVm } from '../viewmodels/templateVm';

const props = withDefaults(
  defineProps<{
    rows: TemplateMeta[];
    /** label of the action column: 編集 (edit) or 作成 (create) */
    action?: 'edit' | 'create';
    showBaseDate?: boolean;
  }>(),
  { action: 'edit', showBaseDate: true },
);

const emit = defineEmits<{ action: [TemplateMeta] }>();

const vms = computed(() => props.rows.map(toTemplateMetaVm));
</script>

<template>
  <div class="rounded-lg border bg-card">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>委託会社コード</TableHead>
          <TableHead>ファンドコード</TableHead>
          <TableHead v-if="showBaseDate">基準日</TableHead>
          <TableHead>版種</TableHead>
          <TableHead>状態</TableHead>
          <TableHead class="text-right">{{ action === 'edit' ? '編集' : '作成' }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="vm in vms" :key="vm.id">
          <TableCell class="font-medium">{{ vm.attributes.companyCode }}</TableCell>
          <TableCell>{{ vm.attributes.fundCode }}</TableCell>
          <TableCell v-if="showBaseDate">{{ vm.attributes.baseDate }}</TableCell>
          <TableCell>{{ vm.attributes.editionType }}</TableCell>
          <TableCell>
            <Badge :variant="vm.statusVariant">{{ vm.statusLabel }}</Badge>
          </TableCell>
          <TableCell class="text-right">
            <Button size="sm" :variant="action === 'edit' ? 'default' : 'outline'" @click="emit('action', vm.raw)">
              <component :is="action === 'edit' ? Pencil : FilePlus2" class="h-4 w-4" />
              {{ action === 'edit' ? '編集' : '作成' }}
            </Button>
          </TableCell>
        </TableRow>
        <TableRow v-if="rows.length === 0">
          <TableCell :colspan="showBaseDate ? 6 : 5" class="py-10 text-center text-muted-foreground">
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
