<script setup lang="ts">
// =============================================================================
// CommentPanel.vue — 右ペインのコメント一覧(検索・絞り込み・新規投稿・返信・解決)
// =============================================================================
// 役割: テンプレート 1 件の全コメントを Adobe Reader のコメントリストと同じ形で出す。
// 新規投稿の入口はここ 1 つ(選択パーツ宛)。スレッド内の操作(返信・解決・編集・削除)は
// 行を開いた中で行い、canvas の吹き出し(`NoteBubble.vue`)と同じ規則で emit する。
// 絞り込み・並びの規則は `commentFilter.ts` に閉じ、ここは描画と入力だけを持つ。
import type { NoteKind, NoteStatus, PartNoteEntry } from '@editor/shared';
import { Check, ChevronDown, ChevronRight, MessageSquare, Pencil, RotateCcw, Trash2 } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import {
  authorsOf,
  type CommentFilter,
  type CommentThread,
  DEFAULT_COMMENT_FILTER,
  filterThreads,
  KIND_LABEL,
  threadsOf,
} from './commentFilter';

const props = withDefaults(
  defineProps<{
    entries: PartNoteEntry[];
    selectedKey: string | null;
    /** 新規投稿ができるか(選択がコメント対象キーへ解決できるか)。 */
    canAdd: boolean;
    /** pathKey → 表示ラベル。Map の挿入順を canvas の出現順として並びに使う。 */
    partLabels: Map<string, string>;
    /** 承認画面向け: 検索と絞り込みを 1 行に畳む。 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  add: [content: string, kind: NoteKind];
  reply: [parent: PartNoteEntry, content: string];
  'set-status': [parent: PartNoteEntry, status: NoteStatus];
  update: [entry: PartNoteEntry, content: string];
  remove: [entry: PartNoteEntry];
  focus: [pathKey: string];
}>();

// ── 1. 絞り込み ──
const filter = reactive<CommentFilter>({ ...DEFAULT_COMMENT_FILTER, kinds: new Set() });
const kindChecked = reactive<Record<NoteKind, boolean>>({ note: false, 'fix-request': false, question: false });
watch(kindChecked, () => {
  filter.kinds = new Set((Object.keys(kindChecked) as NoteKind[]).filter((k) => kindChecked[k]));
});

const threads = computed(() => threadsOf(props.entries));
const authors = computed(() => authorsOf(props.entries));
const partOrder = computed(() => new Map([...props.partLabels.keys()].map((k, i) => [k, i] as const)));
const visible = computed<CommentThread[]>(() =>
  filterThreads(threads.value, filter, { selectedKey: props.selectedKey, partOrder: partOrder.value }),
);
const openCount = computed(() => threads.value.filter((t) => t.parent.status === 'open').length);

function partLabel(key: string): string {
  return props.partLabels.get(key) ?? key;
}

// ── 2. 新規投稿(選択パーツ宛。入口はここだけ) ──
const draft = ref('');
const draftKind = ref<NoteKind>('note');
function submitAdd(): void {
  const text = draft.value.trim();
  if (text === '' || !props.canAdd) return;
  emit('add', draft.value, draftKind.value);
  draft.value = '';
}
// 選択が変わったら下書きを捨てる(別パーツへ書き込む事故を避ける — 右ペインの旧入口と同じ)。
watch(
  () => props.selectedKey,
  () => {
    draft.value = '';
  },
);

// ── 3. 行の展開(返信・解決・編集・削除) ──
const expandedId = ref<string | null>(null);
const replyDraft = ref('');
const editingId = ref<string | null>(null);
const editDraft = ref('');

function toggle(t: CommentThread): void {
  expandedId.value = expandedId.value === t.parent.id ? null : t.parent.id;
  replyDraft.value = '';
  editingId.value = null;
}
function submitReply(t: CommentThread): void {
  if (replyDraft.value.trim() === '') return;
  emit('reply', t.parent, replyDraft.value);
  replyDraft.value = '';
}
function startEdit(e: PartNoteEntry): void {
  editingId.value = e.id;
  editDraft.value = e.content;
}
function commitEdit(e: PartNoteEntry): void {
  if (editDraft.value.trim() !== '') emit('update', e, editDraft.value);
  editingId.value = null;
}
async function requestRemove(e: PartNoteEntry): Promise<void> {
  const ok = await confirm({
    title: e.replyTo === null ? 'このコメントを削除しますか？' : 'この返信を削除しますか？',
    description:
      e.replyTo === null ? '返信も一緒に削除されます。削除したコメントは元に戻せません。' : '削除した返信は元に戻せません。',
    confirmLabel: '削除する',
    variant: 'destructive',
  });
  if (ok) emit('remove', e);
}

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 新規投稿 -->
    <div class="border-b px-3 py-2.5">
      <div class="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <MessageSquare class="h-3.5 w-3.5" />
        <span class="truncate">{{ selectedKey ? `宛先: ${partLabel(selectedKey)}` : 'パーツを選ぶと書けます' }}</span>
        <span class="flex-1" />
        <select v-model="draftKind" data-add-kind class="comment-select" :disabled="!canAdd" aria-label="種別">
          <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ label }}</option>
        </select>
      </div>
      <textarea
        v-model="draft"
        data-add-content
        class="comment-area"
        rows="3"
        :disabled="!canAdd"
        placeholder="このパーツへのコメントを書く…"
        @keydown.ctrl.enter="submitAdd"
      />
      <div class="mt-1.5 flex items-center">
        <span class="text-[10.5px] text-muted-foreground">Ctrl + Enter で追加</span>
        <span class="flex-1" />
        <Button size="sm" data-add-submit :disabled="!canAdd || draft.trim() === ''" @click="submitAdd">追加</Button>
      </div>
    </div>

    <!-- 検索・絞り込み -->
    <div class="space-y-1.5 border-b px-3 py-2">
      <input
        v-model="filter.query"
        type="search"
        class="comment-input"
        placeholder="本文・投稿者で検索"
        aria-label="コメントを検索"
      />
      <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
        <select v-model="filter.status" data-filter-status class="comment-select" aria-label="状態">
          <option value="open">未対応</option>
          <option value="resolved">解決済み</option>
          <option value="all">すべて</option>
        </select>
        <select v-model="filter.author" data-filter-author class="comment-select" aria-label="投稿者">
          <option :value="null">投稿者: すべて</option>
          <option v-for="a in authors" :key="a" :value="a">{{ a }}</option>
        </select>
        <select v-model="filter.sort" data-filter-sort class="comment-select" aria-label="並び順">
          <option value="updated">更新順</option>
          <option value="part">パーツ順</option>
        </select>
      </div>
      <div v-if="!compact" class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
        <label v-for="(label, k) in KIND_LABEL" :key="k" class="flex cursor-pointer items-center gap-1">
          <input v-model="kindChecked[k]" type="checkbox" :data-filter-kind="k" /> {{ label }}
        </label>
        <label class="ml-auto flex cursor-pointer items-center gap-1">
          <input v-model="filter.onlySelected" type="checkbox" data-filter-selected /> 選択パーツのみ
        </label>
      </div>
      <div class="text-[10.5px] text-muted-foreground">
        未対応 {{ openCount }} / 全 {{ threads.length }} 件・表示 {{ visible.length }} 件
      </div>
    </div>

    <!-- 一覧 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="visible.length === 0" class="px-3 py-6 text-center text-[12px] text-muted-foreground">
        表示するコメントがありません。
      </p>
      <ul v-else>
        <li
          v-for="t in visible"
          :key="`${t.parent.templateId}/${t.parent.id}`"
          data-comment-row
          :data-path-key="t.parent.pathKey"
          class="cursor-pointer border-b px-3 py-2 hover:bg-muted/40"
          :class="t.parent.pathKey === selectedKey ? 'bg-primary-soft/40' : ''"
          @click="emit('focus', t.parent.pathKey)"
        >
          <div class="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Badge :variant="t.parent.status === 'open' ? 'warning' : 'secondary'" class="h-[16px] py-0 text-[9.5px]">
              {{ KIND_LABEL[t.parent.kind] }}
            </Badge>
            <span class="truncate">{{ partLabel(t.parent.pathKey) }}</span>
            <span class="flex-1" />
            <span>{{ formatAt(t.lastAt) }}</span>
            <button
              type="button"
              data-expand
              class="rounded p-0.5 hover:bg-muted"
              :aria-label="expandedId === t.parent.id ? '閉じる' : '開く'"
              @click.stop="toggle(t)"
            >
              <ChevronDown v-if="expandedId === t.parent.id" class="h-3.5 w-3.5" />
              <ChevronRight v-else class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="mt-0.5 flex items-baseline gap-1.5 text-[12px]">
            <span class="shrink-0 font-bold">{{ t.parent.createdBy }}</span>
            <span :class="expandedId === t.parent.id ? 'whitespace-pre-wrap break-words' : 'truncate'" class="min-w-0">
              {{ t.parent.content }}
            </span>
          </div>
          <div class="mt-0.5 text-[10.5px] text-muted-foreground">
            <span v-if="t.replies.length">返信 {{ t.replies.length }}</span>
            <span v-if="t.parent.status === 'resolved'" class="ml-1.5">解決済み</span>
          </div>

          <!-- 展開: 返信一覧・返信入力・解決/編集/削除 -->
          <div v-if="expandedId === t.parent.id" class="mt-2 space-y-2" @click.stop>
            <div class="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                data-resolve
                @click="emit('set-status', t.parent, t.parent.status === 'open' ? 'resolved' : 'open')"
              >
                <Check v-if="t.parent.status === 'open'" class="h-3.5 w-3.5" />
                <RotateCcw v-else class="h-3.5 w-3.5" />
                {{ t.parent.status === 'open' ? '解決にする' : '未対応に戻す' }}
              </Button>
              <span class="flex-1" />
              <Button variant="ghost" size="iconSm" aria-label="このコメントを編集" @click="startEdit(t.parent)">
                <Pencil class="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="このコメントを削除" @click="requestRemove(t.parent)">
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
            <template v-if="editingId === t.parent.id">
              <textarea v-model="editDraft" class="comment-area" rows="3" />
              <div class="flex gap-1.5">
                <Button size="sm" @click="commitEdit(t.parent)">保存</Button>
                <Button size="sm" variant="outline" @click="editingId = null">取消</Button>
              </div>
            </template>

            <div v-for="r in t.replies" :key="`${r.templateId}/${r.id}`" class="ml-3 border-l-2 pl-2">
              <div class="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <span class="font-bold text-foreground">{{ r.createdBy }}</span>
                <span>{{ formatAt(r.createdAt) }}</span>
                <span class="flex-1" />
                <Button variant="ghost" size="iconSm" aria-label="この返信を編集" @click="startEdit(r)">
                  <Pencil class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="iconSm" class="text-destructive" aria-label="この返信を削除" @click="requestRemove(r)">
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
              <template v-if="editingId === r.id">
                <textarea v-model="editDraft" class="comment-area" rows="2" />
                <div class="mt-1 flex gap-1.5">
                  <Button size="sm" @click="commitEdit(r)">保存</Button>
                  <Button size="sm" variant="outline" @click="editingId = null">取消</Button>
                </div>
              </template>
              <p v-else class="whitespace-pre-wrap break-words text-[12px]">
                {{ r.content }}<span v-if="r.updatedAt" class="ml-1 text-[10px] text-muted-foreground">(編集済み)</span>
              </p>
            </div>

            <textarea
              v-model="replyDraft"
              data-reply-content
              class="comment-area"
              rows="2"
              placeholder="返信を書く…"
              @keydown.ctrl.enter="submitReply(t)"
            />
            <div class="flex justify-end">
              <Button size="sm" data-reply-submit :disabled="replyDraft.trim() === ''" @click="submitReply(t)">返信</Button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* 入力欄は固定 UI スケールで常に読める(キャンバスズーム非依存。Inspector の memo-area と同じ)。 */
.comment-area,
.comment-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
}
.comment-area:disabled {
  opacity: 0.5;
}
.comment-select {
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  padding: 2px 6px;
  font-size: 11px;
}
</style>
