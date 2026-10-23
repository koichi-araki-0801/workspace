<script setup lang="ts">
// =============================================================================
// CompanyCodeLabel.vue — 委託会社「略称（Rep1 の委託会社コード）」の共有表示部品
// =============================================================================
import { useRep1Names } from '@/lib/useRep1Names';

/** 略称(ファイル名の会社コード)を受け、Rep1 から引いたコードを括弧で添える。 */
defineProps<{ code: string }>();
const { resolveCompanies, companyLabel } = useRep1Names();
resolveCompanies();
</script>

<template>
  <span class="mono font-medium">{{ companyLabel(code) }}</span>
</template>
