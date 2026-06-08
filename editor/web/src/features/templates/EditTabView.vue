<script setup lang="ts">
import { type DropdownQuery, isErr, type TemplateMeta } from '@editor/shared';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTemplateRepo } from '@/api/repositories';
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
    <h2 class="text-lg font-semibold">テンプレートを検索</h2>
    <SearchFilters @search="search" />
    <TemplateTable v-if="searched" :rows="rows" action="edit" @action="openEditor" />
    <p v-else class="text-sm text-muted-foreground">条件を選んで検索してください</p>
  </div>
</template>
