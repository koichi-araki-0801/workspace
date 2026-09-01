<script setup lang="ts">
// =============================================================================
// NoteBubble.vue — キャンバス余白に出すメモの吹き出し(選択パーツのスレッド)
// =============================================================================
// 役割: 選択パーツの投稿列を表示し、その場での編集と削除を受ける。追加は右ペインに一本化
// しているのでここには置かない(入口を 2 つ持つと、どちらで書いたかで挙動が違うように
// 見える)。位置は `noteBubbleLayout.ts` が決めた値をそのまま使う。
import { type PartNoteEntry, parseTemplateFileName } from '@editor/shared';
import { Pencil, StickyNote, Trash2, X } from '@lucide/vue';
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import type { BubbleAnchor } from './noteBubbleLayout';

const props = defineProps<{
  entries: PartNoteEntry[];
  anchor: BubbleAnchor;
}>();

const emit = defineEmits<{
  update: [PartNoteEntry, string];
  remove: [PartNoteEntry];
  close: [];
}>();

// 編集中の投稿の識別子と入力中の本文。1 度に 1 件だけ編集する。
//
// キー・比較は `id` 単体ではなく `templateId/id` の対で行う。旧形式ファイルの遅延変換
// (`server/src/files/notesFile.ts` の `normalizeStored`)は `legacy:<pathKey>` を id に
// 使うため、ファイル(= 版インスタンス)が違えば同じ pathKey を持つ投稿が同じ id を名乗り
// うる(交付版⇄全体版のペアをマージした本スレッドは複数ファイル由来の投稿を同時に表示する)。
// id だけで一意性を仮定すると、2 件を同時に編集モードへ開いてしまう。
function entryKey(entry: PartNoteEntry): string {
  return `${entry.templateId}/${entry.id}`;
}

const editingKey = ref<string | null>(null);
const draft = ref('');

function startEdit(entry: PartNoteEntry): void {
  editingKey.value = entryKey(entry);
  draft.value = entry.content;
}

function commitEdit(entry: PartNoteEntry): void {
  if (draft.value.trim() !== '') emit('update', entry, draft.value);
  editingKey.value = null;
}

/** 投稿がどの版種で書かれたかを id から解く(保存はしない — 同じ事実を 2 箇所に持たない)。 */
function editionOf(entry: PartNoteEntry): string {
  return parseTemplateFileName(`${entry.templateId}.html`)?.editionType ?? '';
}

/** 表示用の日時(年は省く。同一基準日のスレッドなので月日と時刻で足りる)。 */
function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

async function requestRemove(entry: PartNoteEntry): Promise<void> {
  const ok = await confirm({
    title: 'このメモを削除しますか？',
    description: '削除したメモは元に戻せません。',
    confirmLabel: '削除する',
    variant: 'destructive',
  });
  if (ok) emit('remove', entry);
}
</script>

<template>
  <div
    class="note-bubble"
    :class="anchor.side === 'left' ? 'note-bubble-left' : 'note-bubble-right'"
    :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"
  >
    <div class="note-bubble-head">
      <StickyNote class="h-3.5 w-3.5" />
      <span>メモ</span>
      <span class="flex-1" />
      <span class="note-bubble-count">{{ entries.length }}</span>
      <Button variant="ghost" size="iconSm" aria-label="メモを閉じる" @click="emit('close')">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div class="note-bubble-body">
      <div v-for="e in entries" :key="entryKey(e)" class="note-entry">
        <div class="note-entry-head">
          <span class="note-entry-who">{{ e.createdBy }}</span>
          <span>{{ formatAt(e.createdAt) }}</span>
          <span v-if="editionOf(e)" class="note-entry-edition">{{ editionOf(e) }}</span>
          <span class="flex-1" />
          <Button variant="ghost" size="iconSm" aria-label="このメモを編集" @click="startEdit(e)">
            <Pencil class="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            class="text-destructive"
            aria-label="このメモを削除"
            @click="requestRemove(e)"
          >
            <Trash2 class="h-3 w-3" />
          </Button>
        </div>

        <template v-if="editingKey === entryKey(e)">
          <textarea v-model="draft" class="note-entry-input" rows="3" />
          <div class="mt-1.5 flex gap-1.5">
            <Button size="sm" @click="commitEdit(e)">保存</Button>
            <Button size="sm" variant="outline" @click="editingKey = null">取消</Button>
          </div>
        </template>
        <div v-else class="note-entry-body">
          {{ e.content }}
          <span v-if="e.updatedAt" class="note-entry-edited">(編集済み)</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 吹き出しは overlay 層(非スクロール)に絶対配置する。位置は `noteBubbleLayout` が決める。
   幅は固定 px でズーム非依存 — メモは注釈であり、帳票と一緒に拡大縮小させない。常にページへ
   重ねて出す(`noteBubbleLayout` の設計コメントを見よ)ので、下に透ける帳票の文字と混ざらない
   よう背景は不透明(`var(--card)` はアルファ無し)、輪郭は影で強めに立てる。 */
.note-bubble {
  position: absolute;
  /* overlay 層は `pointer-events: none` で、操作を受ける要素だけが復帰させる約束
     (`EditorView.vue` のハンドル類と同じ)。これが無いとクリックが吹き出しを素通りして
     canvas の iframe に当たり、閉じる・編集・削除のどれも押せない。 */
  pointer-events: auto;
  /* 同じ overlay 層のハンドル・ページ境界ガイド(z-index 22-26)より前に出す。 */
  z-index: 28;
  width: 244px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  box-shadow: 0 6px 20px rgb(0 0 0 / 45%);
}

/* 吹き出しの尾(どちら側から出たかを示す小さな三角)。`side` に応じて角を反転する。 */
.note-bubble::after {
  content: '';
  position: absolute;
  bottom: -7px;
  width: 12px;
  height: 12px;
  background: var(--card);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  transform: rotate(45deg);
}

.note-bubble-right::after {
  right: 16px;
}

.note-bubble-left::after {
  left: 16px;
}

.note-bubble-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 700;
}

.note-bubble-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--secondary);
  font-size: 10px;
  font-weight: 700;
}

.note-bubble-body {
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.note-entry-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--muted-foreground);
}

.note-entry-who {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--foreground);
}

.note-entry-edition {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 9.5px;
  font-weight: 700;
}

.note-entry-body {
  margin-top: 1px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.note-entry-edited {
  margin-left: 4px;
  font-size: 10px;
  color: var(--muted-foreground);
}

.note-entry-input {
  width: 100%;
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}
</style>
