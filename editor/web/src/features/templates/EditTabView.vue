<script setup lang="ts">
import { type DropdownQuery, isErr, type TemplateMeta } from '@editor/shared';
import { Search } from '@lucide/vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTemplateRepo } from '@/api/repositories';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import SearchFilters from './components/SearchFilters.vue';
import TemplateTable from './components/TemplateTable.vue';

const router = useRouter();
const repo = useTemplateRepo();
const { run } = useAsyncResult();
const rows = ref<TemplateMeta[]>([]);
const searched = ref(false);

async function search(q: DropdownQuery) {
  const result = await run(() => repo.listTemplates(q));
  if (isErr(result)) return;
  rows.value = result.value;
  searched.value = true;
}

function openEditor(m: TemplateMeta) {
  router.push({ name: 'editor', params: { id: m.id } });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold">テンプレートを検索</h2>
    <SearchFilters @search="search" />
    <TemplateTable v-if="searched" :rows="rows" action="edit" @action="openEditor" />
    <EmptyState
      v-else
      :icon="Search"
      title="テンプレートを検索"
      hint="委託会社・ファンド・基準日などの条件を選んで検索してください。"
    />
  </div>
</template>
