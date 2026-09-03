<script setup lang="ts">
// =============================================================================
// NoteBubble.vue — キャンバス余白に出すメモの吹き出し(選択パーツのスレッド)
// =============================================================================
// 役割: 選択パーツの投稿列を表示し、その場での編集と削除を受ける。追加は右ペインに一本化
// しているのでここには置かない(入口を 2 つ持つと、どちらで書いたかで挙動が違うように
// 見える)。位置は `noteBubbleLayout.ts` が決めた値をそのまま使う。
import type { NoteStatus, PartNoteEntry } from '@editor/shared';
import {
  Check,
  ChevronDown,
  ChevronRight,
  MessageSquareReply,
  Pencil,
  RotateCcw,
  StickyNote,
  Trash2,
  X,
} from '@lucide/vue';
import { computed, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import { KIND_LABEL, threadsOf } from './comments/commentFilter';
import type { BubbleAnchor } from './noteBubbleLayout';

const props = defineProps<{
  entries: PartNoteEntry[];
  anchor: BubbleAnchor;
}>();

const emit = defineEmits<{
  update: [PartNoteEntry, string];
  remove: [PartNoteEntry];
  reply: [PartNoteEntry, string];
  'set-status': [PartNoteEntry, NoteStatus];
  close: [];
}>();

// 編集中の投稿の識別子と入力中の本文。1 度に 1 件だけ編集する。
//
// キー・比較は `id` 単体ではなく `templateId/id` の対で行う。旧形式ファイルの遅延変換
// (`server/src/files/notesFile.ts` の `normalizeStored`)は `legacy:<pathKey>` を id に
// 使うため、ファイル(= 版インスタンス)が違えば同じ pathKey を持つ投稿が同じ id を名乗り
// うる。表示は今は自版のスレッドに閉じているが、`templateId` を含めておけば他ファイル由来の
// 投稿が並ぶ表示に変わっても id 衝突で 2 件を同時に編集モードへ開くことはない。
function entryKey(entry: PartNoteEntry): string {
  return `${entry.templateId}/${entry.id}`;
}

const threads = computed(() => threadsOf(props.entries));
const editingKey = ref<string | null>(null);
const draft = ref('');
const replyingKey = ref<string | null>(null);
const replyDraft = ref('');

// 解決済みスレッドは既定で本文を畳む(レビューで済んだものを目に入れない・押せば読める)。
// 開閉は親投稿ごとに憶える。「解決にする」を押した瞬間に自動で畳むと押した本人が本文を
// 見失うため、`expandedKeys` は解決操作からは触らない — 表示可否は現在の status からその都度
// 導出する(`isCollapsed`)ので、未対応へ戻せば自然に開いた状態へ戻る。
const expandedKeys = ref<Set<string>>(new Set());

function isCollapsed(t: { parent: PartNoteEntry }): boolean {
  return t.parent.status === 'resolved' && !expandedKeys.value.has(entryKey(t.parent));
}

function toggleExpand(parent: PartNoteEntry): void {
  const key = entryKey(parent);
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedKeys.value = next;
}

/** 畳んだ行に出す 1 行要約(本文の先頭行のみ。折り返しは `truncate` に任せる)。 */
function summaryOf(content: string): string {
  return content.split('\n', 1)[0];
}

function startEdit(entry: PartNoteEntry): void {
  editingKey.value = entryKey(entry);
  draft.value = entry.content;
}

function commitEdit(entry: PartNoteEntry): void {
  if (draft.value.trim() !== '') emit('update', entry, draft.value);
  editingKey.value = null;
}

function startReply(parent: PartNoteEntry): void {
  replyingKey.value = entryKey(parent);
  replyDraft.value = '';
}

function commitReply(parent: PartNoteEntry): void {
  if (replyDraft.value.trim() !== '') emit('reply', parent, replyDraft.value);
  replyingKey.value = null;
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
  const threadForEntry = threads.value.find((t) => entryKey(t.parent) === entryKey(entry));
  const isParent = threadForEntry?.parent === entry;
  const hasReplies = !!(isParent && threadForEntry?.replies.length);

  const ok = await confirm({
    title: 'このコメントを削除しますか？',
    description: `削除したコメントは元に戻せません。${hasReplies ? '返信も一緒に削除されます。' : ''}`,
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
      <span>コメント</span>
      <span class="flex-1" />
      <span class="note-bubble-count">{{ threads.length }}</span>
      <Button variant="ghost" size="iconSm" aria-label="コメントを閉じる" @click="emit('close')">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div class="note-bubble-body">
      <div
        v-for="t in threads"
        :key="entryKey(t.parent)"
        class="note-entry"
        :class="t.parent.status === 'resolved' ? 'note-entry-resolved' : ''"
        data-note-parent
      >
        <div class="note-entry-head">
          <!-- 折りたたみ切替は解決済みスレッドにのみ出す(未対応は畳む対象が無い)。頭行の
               残りのボタン群は畳んだ状態でも常に押せる — レビューが済んだ投稿を一覧性優先で
               隠しつつ、状態を戻す・読み直す操作の入口までは塞がない。 -->
          <Button
            v-if="t.parent.status === 'resolved'"
            variant="ghost"
            size="iconSm"
            :aria-label="isCollapsed(t) ? '開く' : '閉じる'"
            :title="isCollapsed(t) ? '開く' : '閉じる'"
            data-note-collapse
            @click="toggleExpand(t.parent)"
          >
            <ChevronRight v-if="isCollapsed(t)" class="h-3 w-3" />
            <ChevronDown v-else class="h-3 w-3" />
          </Button>
          <span class="note-entry-kind">{{ KIND_LABEL[t.parent.kind] }}</span>
          <span class="note-entry-who">{{ t.parent.createdBy }}</span>
          <span>{{ formatAt(t.parent.createdAt) }}</span>
          <span class="flex-1" />
          <Button
            variant="ghost"
            size="iconSm"
            :aria-label="t.parent.status === 'open' ? '解決にする' : '未対応に戻す'"
            :title="t.parent.status === 'open' ? '解決にする' : '未対応に戻す'"
            @click="emit('set-status', t.parent, t.parent.status === 'open' ? 'resolved' : 'open')"
          >
            <Check v-if="t.parent.status === 'open'" class="h-3 w-3" />
            <RotateCcw v-else class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" aria-label="返信する" title="返信する" @click="startReply(t.parent)">
            <MessageSquareReply class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" aria-label="このコメントを編集" @click="startEdit(t.parent)">
            <Pencil class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="このコメントを削除" @click="requestRemove(t.parent)">
            <Trash2 class="h-3 w-3" />
          </Button>
        </div>

        <!-- 畳んだ状態(解決済み + 未展開)は要約 1 行だけ出す。編集・返信の入力中は入力欄を
             隠さないよう、その間だけ展開時と同じ表示に戻す。 -->
        <div
          v-if="isCollapsed(t) && editingKey !== entryKey(t.parent) && replyingKey !== entryKey(t.parent)"
          class="note-entry-summary truncate"
        >
          {{ summaryOf(t.parent.content) }}
          <span v-if="t.replies.length > 0" class="note-entry-edited">・返信 {{ t.replies.length }}</span>
        </div>
        <template v-else>
          <template v-if="editingKey === entryKey(t.parent)">
            <textarea v-model="draft" class="note-entry-input" rows="3" />
            <div class="mt-1.5 flex gap-1.5">
              <Button size="sm" @click="commitEdit(t.parent)">保存</Button>
              <Button size="sm" variant="outline" @click="editingKey = null">取消</Button>
            </div>
          </template>
          <div v-else class="note-entry-body">
            {{ t.parent.content }}
            <span v-if="t.parent.updatedAt" class="note-entry-edited">(編集済み)</span>
            <span v-if="t.parent.status === 'resolved'" class="note-entry-edited">・解決済み</span>
          </div>

          <div v-for="r in t.replies" :key="entryKey(r)" class="note-reply" data-note-reply>
            <div class="note-entry-head">
              <span class="note-entry-who">{{ r.createdBy }}</span>
              <span>{{ formatAt(r.createdAt) }}</span>
              <span class="flex-1" />
              <Button variant="ghost" size="iconSm" aria-label="この返信を編集" @click="startEdit(r)">
                <Pencil class="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="この返信を削除" @click="requestRemove(r)">
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
            <template v-if="editingKey === entryKey(r)">
              <textarea v-model="draft" class="note-entry-input" rows="2" />
              <div class="mt-1.5 flex gap-1.5">
                <Button size="sm" @click="commitEdit(r)">保存</Button>
                <Button size="sm" variant="outline" @click="editingKey = null">取消</Button>
              </div>
            </template>
            <div v-else class="note-entry-body">
              {{ r.content }}
              <span v-if="r.updatedAt" class="note-entry-edited">(編集済み)</span>
            </div>
          </div>

          <template v-if="replyingKey === entryKey(t.parent)">
            <textarea v-model="replyDraft" class="note-entry-input mt-1.5" rows="2" placeholder="返信を書く…" data-bubble-reply />
            <div class="mt-1.5 flex gap-1.5">
              <Button size="sm" @click="commitReply(t.parent)">返信</Button>
              <Button size="sm" variant="outline" @click="replyingKey = null">取消</Button>
            </div>
          </template>
        </template>
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

.note-entry-kind {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--warning);
  color: #fff;
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

.note-entry-resolved .note-entry-kind {
  background: var(--secondary);
  color: var(--muted-foreground);
}

.note-entry-resolved .note-entry-body {
  color: var(--muted-foreground);
}

/* 畳んだ解決済みスレッドの要約行。`.note-bubble` 幅 244px の中で 1 行に収めるため
   `truncate`(テンプレート側)で省略する。 */
.note-entry-summary {
  margin-top: 1px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.note-reply {
  margin: 6px 0 0 10px;
  padding-left: 8px;
  border-left: 2px solid var(--border);
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
