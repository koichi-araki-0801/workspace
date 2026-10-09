<script setup lang="ts">
// =============================================================================
// FundCodeName.vue — ファンドコード＋Rep1 のファンド名の共有表示部品
// =============================================================================
import { watch } from 'vue';
import { useRep1Names } from '@/lib/useRep1Names';

/**
 * ファンドコード(等幅)＋Rep1 のファンド名(淡色)。Rep1 のファンドは会社単位でしか引けない
 * ので委託会社の略称も受ける。取得前・失敗の間はコードだけ、Rep1 に無ければ「（未登録）」。
 * 名前は `useRep1Names` のモジュールキャッシュで解決するので、一覧の各セルで使っても
 * 重複取得は起きない。
 */
const props = defineProps<{ companyCode: string; code: string }>();
const { resolveFunds, fundName } = useRep1Names();
watch(
  () => props.companyCode,
  (c) => resolveFunds(c),
  { immediate: true },
);
</script>

<template>
  <span class="mono font-medium">{{ code }}</span>
  <span v-if="fundName(companyCode, code)" class="ml-2 text-sm text-muted-foreground">{{
    fundName(companyCode, code)
  }}</span>
</template>
