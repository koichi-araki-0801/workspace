<script setup lang="ts">
// =============================================================================
// PartTree.vue — 左ペイン(編集を許可 / パーツを追加トグル + catalog)
// =============================================================================
import type { PartCatalogItem } from '@editor/shared';
import { Lock, PanelLeftClose, Wand2 } from '@lucide/vue';
import Button from '@/components/ui/Button.vue';
import { Tooltip } from '@/components/ui/overlays';
import SelectableRow from '@/components/ui/SelectableRow.vue';
import PartCatalog from './PartCatalog.vue';

const allowAdd = defineModel<boolean>('allowAdd', { default: false });
const allowEdit = defineModel<boolean>('allowEdit', { default: false });
const emit = defineEmits<{ select: [PartCatalogItem]; insert: [PartCatalogItem]; collapse: [] }>();
</script>

<template>
  <nav class="flex w-[272px] shrink-0 flex-col overflow-hidden border-r bg-card">
    <div class="flex h-[46px] shrink-0 items-center gap-2 border-b px-3.5">
      <Wand2 class="h-[15px] w-[15px] text-primary" />
      <span class="text-[12.5px] font-bold text-foreground">編集オプション</span>
      <span class="flex-1" />
      <Tooltip text="左パネルを畳む">
        <Button
          variant="ghost"
          size="iconSm"
          class="text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="左パネルを畳む"
          @click="emit('collapse')"
        >
          <PanelLeftClose class="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>

    <!-- トグル: 編集を許可 -->
    <SelectableRow :checked="allowEdit" title="編集を許可" @toggle="allowEdit = !allowEdit">
      {{ allowEdit ? 'キャンバスでテキスト編集・並べ替え・レイアウト調整ができます' : 'キャンバスは閲覧のみ（選択は可能）' }}
    </SelectableRow>

    <!-- トグル: パーツを追加 -->
    <SelectableRow :checked="allowAdd" title="パーツを追加" @toggle="allowAdd = !allowAdd">
      {{ allowAdd ? '分類から選んでパーツを挿入できます' : 'チェックを入れると追加メニューを表示' }}
    </SelectableRow>

    <!-- 追加 OFF: ロック中のヒント -->
    <div
      v-if="!allowAdd"
      class="grid flex-1 place-items-center px-6 text-center text-muted-foreground"
    >
      <div>
        <Lock class="mx-auto mb-2.5 h-6 w-6 opacity-40" />
        <p class="text-[12.5px] leading-relaxed">
          パーツの追加はオフです。<br />「パーツを追加」をオンにすると、<br />分類から挿入できます。
        </p>
      </div>
    </div>

    <!-- 追加 ON: 既存の cascading catalog -->
    <div v-else class="flex-1 overflow-hidden">
      <PartCatalog @select="emit('select', $event)" @insert="emit('insert', $event)" />
    </div>
  </nav>
</template>
