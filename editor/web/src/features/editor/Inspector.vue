<script setup lang="ts">
// =============================================================================
// Inspector.vue — 右ペイン(選択パーツの編集可能プロパティ + 修正履歴)
// =============================================================================
/**
 * 右ペイン: 選択パーツのプロパティを「編集可能」に提示し、修正履歴を併載するパネル。
 *
 * 以前は read-only インスペクタ + 中央 canvas の浮動ツールバー(`PartToolbar.vue`)に
 * 編集 UI が分散していた。本コンポーネントへ集約し、サイズ・配置 / 余白 / 改ページ /
 * 修正履歴を「折りたたみ式セクション」(タブにしない)として縦積み表示する。
 * 幾何の編集ロジック(数値 clamp・配置・改ページ)は撤去した `PartToolbar` から移植。
 *
 * 折りたたみの初期状態は「編集許可」(`editMode` = `useTemplateEditor.ts` の `allowEdit`)に
 * 連動: 許可 ON で編集セクションのみ展開し履歴は畳む、OFF で逆(閲覧時は履歴を主役)。連動は
 * 許可の切替時のみ発火するため、その後ユーザーが手動でトグルした状態は次の切替まで保持される。
 */
import type { PartCatalogItem, PartHistoryEntry } from '@editor/shared';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  FileText,
  History,
  Minus,
  PanelRight,
  Plus,
  RotateCcw,
  SplitSquareVertical,
  StickyNote,
  Table,
  Trash2,
  TrendingUp,
} from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type Align, clampMarginMm, clampWidthPct, type LayoutGeom, WIDTH_PCT_MAX } from './geom';
import type { SelectedInfo } from './useGrapes';

const props = defineProps<{
  selected: SelectedInfo | null;
  part: PartCatalogItem | null;
  geom: LayoutGeom | null;
  history: PartHistoryEntry[];
  /** 全パーツ横断表示(未選択時)で各履歴行のパーツを示すラベル(`partKey` → `ページN・パーツM`)。 */
  partLabels?: Map<string, string>;
  /** 選択パーツの版を跨ぐメモ本文(`usePartNote`)。 */
  note: string;
  /** 選択がメモ対象キーへ解決できるか(不能なら入力を無効化)。 */
  canNote: boolean;
  editMode: boolean;
  canUp: boolean;
  canDown: boolean;
}>();

// 編集操作は `useTemplateEditor.ts` のハンドラ(`applyGeom` / `moveSelected` /
// `resetGeom` / `deletePart`)へそのまま委譲する。`PartToolbar` と同形の emit に揃える。
const emit = defineEmits<{
  apply: [Partial<LayoutGeom>];
  move: [-1 | 1];
  reset: [];
  del: [];
  'update-note': [string];
}>();

const label = computed(() => props.part?.name ?? props.selected?.name ?? '');
const group = computed(() => props.part?.classification.minorClass ?? props.selected?.name ?? '');

// 修正履歴が複数パーツにまたがるか(= 未選択の「全パーツ表示」)。真のときだけ各行に
// パーツ識別ラベルを併記する。単一パーツ選択時は全行同一で冗長なので付けない。
const historySpansParts = computed(() => new Set(props.history.map((h) => h.partKey)).size > 1);
/** 履歴行のパーツラベル。マップに無い(削除済み)パーツは控えめに示す。 */
function partLabelOf(partKey: string): string {
  return props.partLabels?.get(partKey) ?? '削除済みパーツ';
}

// ── 1. 折りたたみ状態 ──
// 既定は「閲覧」相当(編集セクションを畳み履歴を開く)。`editMode` 連動で切り替える。
// `memo` は editMode 連動の対象外(注釈なので閲覧/編集どちらでも開いておく既定)。
const open = reactive({ size: false, margin: false, pagebreak: false, memo: true, history: true });
watch(
  () => props.editMode,
  (on) => {
    open.size = on;
    open.margin = on;
    open.pagebreak = on;
    open.history = !on;
  },
  { immediate: true },
);

// ── 2. 数値ミラー(幅 / 上下余白) ──
// ライブな幾何と同期しつつ、入力中の文字列を保持する(移植元: `PartToolbar.vue`)。
const num = reactive({ widthPct: '100', marginTop: '0', marginBottom: '0' });
watch(
  () => props.geom,
  (g) => {
    if (!g) return;
    num.widthPct = String(g.widthPct);
    num.marginTop = String(g.marginTop);
    num.marginBottom = String(g.marginBottom);
  },
  { immediate: true, deep: true },
);

// ── 2b. メモ(版を跨ぐパーツ単位)のミラー ──
// 入力中の文字列をローカル保持しつつ props.note(ストア値)と同期する。入力ごとに親へ
// emit し、永続化は `usePartNote` 側で debounce される。
const noteText = ref(props.note);
watch(
  () => props.note,
  (v) => {
    if (v !== noteText.value) noteText.value = v;
  },
);
function onNoteInput() {
  emit('update-note', noteText.value);
}

// ── 3. 編集ハンドラ ──
const canAlign = () => !!props.geom && props.geom.widthPct < 100;

// 「表示のみ」モードで配置を値表示するための日本語ラベル(`canAlign()` 内のみ呼ぶ想定)。
const ALIGN_LABEL: Record<Align, string> = {
  left: '左寄せ',
  center: '中央',
  right: '右寄せ',
  stretch: '全幅',
};
const alignLabel = computed(() => (props.geom ? ALIGN_LABEL[props.geom.align] : ''));

// 改ページの 3 項目(編集 toggle / 表示のみの読み取り行で共有)。
const PB_ITEMS = [
  { key: 'pageBreakBefore', icon: ArrowUpToLine, label: '前で改ページ' },
  { key: 'pageBreakAfter', icon: ArrowDownToLine, label: '後で改ページ' },
  { key: 'keepTogether', icon: SplitSquareVertical, label: 'ページ内で分割しない' },
] as const;

function setAlign(align: Align) {
  if (props.editMode && canAlign()) emit('apply', { align });
}

function togglePB(key: 'pageBreakBefore' | 'pageBreakAfter' | 'keepTogether') {
  if (props.editMode && props.geom) emit('apply', { [key]: !props.geom[key] } as Partial<LayoutGeom>);
}

function onEnter(e: KeyboardEvent) {
  (e.target as HTMLInputElement).blur();
}

function commitNum(key: 'widthPct' | 'marginTop' | 'marginBottom', raw: string) {
  if (!props.geom) return;
  let n = Math.round(Number(raw));
  if (Number.isNaN(n)) n = props.geom[key];
  n = key === 'widthPct' ? clampWidthPct(n) : clampMarginMm(n);
  num[key] = String(n);
  if (key === 'widthPct') {
    emit('apply', {
      widthPct: n,
      align: n >= WIDTH_PCT_MAX ? 'stretch' : props.geom.align === 'stretch' ? 'left' : props.geom.align,
    });
  } else {
    emit('apply', { [key]: n } as Partial<LayoutGeom>);
  }
}

// 数値の増減(ステッパーボタン / 上下キー)。現在のミラー値を起点に ±delta し、clamp と
// emit は `commitNum` に委譲する(幅は 1%、余白は 1mm 刻み)。
function stepNum(key: 'widthPct' | 'marginTop' | 'marginBottom', delta: number) {
  if (!props.geom) return;
  const cur = Math.round(Number(num[key]));
  const base = Number.isNaN(cur) ? props.geom[key] : cur;
  commitNum(key, String(base + delta));
}
</script>

<template>
  <aside class="flex w-[312px] shrink-0 flex-col overflow-hidden border-l bg-card">
    <div class="flex h-[46px] shrink-0 items-center border-b px-4 text-[12.5px] font-bold">
      <span>プロパティ</span>
      <span class="flex-1" />
      <Badge v-if="selected && !editMode" variant="secondary" class="h-[19px] gap-1 py-0">
        <Eye class="h-[11px] w-[11px]" /> 表示のみ
      </Badge>
    </div>

    <!-- 未選択 -->
    <div
      v-if="!selected || !geom"
      class="grid flex-1 place-items-center px-6 text-center text-muted-foreground"
    >
      <div>
        <PanelRight class="mx-auto mb-2.5 h-[26px] w-[26px] opacity-40" />
        <p class="text-[13px] leading-relaxed">
          キャンバスでパーツを選ぶと、<br />現在の設定と修正履歴を表示します。
        </p>
      </div>
    </div>

    <template v-else>
      <!-- 選択パーツの識別情報(常に表示、折りたたみ不可) -->
      <div class="border-b bg-primary-soft/50 px-4 py-3">
        <div class="text-sm font-bold text-foreground">{{ label }}</div>
        <div class="mt-0.5 text-[11.5px] text-muted-foreground">
          {{ group }} ・ <span class="mono">#{{ selected.id }}</span>
          <template v-if="selected.isJinja"> ・ <span class="text-warning-foreground">自動入力</span></template>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- ── サイズ・配置 ── -->
        <section class="border-b">
          <button type="button" class="sec-head" @click="open.size = !open.size">
            <component :is="open.size ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
            <Table class="h-3.5 w-3.5" /> サイズ・配置
          </button>
          <div v-show="open.size" class="px-4 pb-3">
            <div class="ins-row">
              <span class="text-muted-foreground">幅</span>
              <div v-if="editMode" class="ins-num">
                <button type="button" class="ins-step" title="減らす" @click="stepNum('widthPct', -1)">
                  <Minus class="h-3 w-3" />
                </button>
                <input
                  v-model="num.widthPct"
                  inputmode="numeric"
                  class="mono"
                  @blur="commitNum('widthPct', num.widthPct)"
                  @keydown.enter="onEnter"
                  @keydown.up.prevent="stepNum('widthPct', 1)"
                  @keydown.down.prevent="stepNum('widthPct', -1)"
                />
                <span class="ins-unit">%</span>
                <button type="button" class="ins-step" title="増やす" @click="stepNum('widthPct', 1)">
                  <Plus class="h-3 w-3" />
                </button>
              </div>
              <span v-else class="mono font-semibold tabular-nums">{{ geom.widthPct }} %</span>
            </div>
            <!-- 横の配置: 幅 100% では効かないため、幅 < 100% のときだけ出す -->
            <div v-if="canAlign()" class="ins-row">
              <span class="text-muted-foreground">横の配置</span>
              <div v-if="editMode" class="flex gap-0.5">
                <button type="button" class="seg" title="左寄せ" :class="cn(geom.align === 'left' && 'seg-on')" @click="setAlign('left')">
                  <AlignLeft class="h-[15px] w-[15px]" />
                </button>
                <button type="button" class="seg" title="中央" :class="cn(geom.align === 'center' && 'seg-on')" @click="setAlign('center')">
                  <AlignCenter class="h-[15px] w-[15px]" />
                </button>
                <button type="button" class="seg" title="右寄せ" :class="cn(geom.align === 'right' && 'seg-on')" @click="setAlign('right')">
                  <AlignRight class="h-[15px] w-[15px]" />
                </button>
              </div>
              <span v-else class="font-semibold">{{ alignLabel }}</span>
            </div>
            <!-- 左インデントは read-only(編集経路なし)。0mm は情報量ゼロなので隠す -->
            <div v-if="geom.indent > 0" class="ins-row">
              <span class="text-muted-foreground">左インデント</span>
              <span class="mono font-semibold tabular-nums">{{ geom.indent }} mm</span>
            </div>
          </div>
        </section>

        <!-- ── 余白 ── -->
        <section class="border-b">
          <button type="button" class="sec-head" @click="open.margin = !open.margin">
            <component :is="open.margin ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
            <TrendingUp class="h-3.5 w-3.5" /> 余白（前後の間隔）
          </button>
          <div v-show="open.margin" class="px-4 pb-3">
            <div class="ins-row">
              <span class="text-muted-foreground">上の余白</span>
              <div v-if="editMode" class="ins-num">
                <button type="button" class="ins-step" title="減らす" @click="stepNum('marginTop', -1)">
                  <Minus class="h-3 w-3" />
                </button>
                <input
                  v-model="num.marginTop"
                  inputmode="numeric"
                  class="mono"
                  @blur="commitNum('marginTop', num.marginTop)"
                  @keydown.enter="onEnter"
                  @keydown.up.prevent="stepNum('marginTop', 1)"
                  @keydown.down.prevent="stepNum('marginTop', -1)"
                />
                <span class="ins-unit">mm</span>
                <button type="button" class="ins-step" title="増やす" @click="stepNum('marginTop', 1)">
                  <Plus class="h-3 w-3" />
                </button>
              </div>
              <span v-else class="mono font-semibold tabular-nums">{{ geom.marginTop }} mm</span>
            </div>
            <div class="ins-row">
              <span class="text-muted-foreground">下の余白</span>
              <div v-if="editMode" class="ins-num">
                <button type="button" class="ins-step" title="減らす" @click="stepNum('marginBottom', -1)">
                  <Minus class="h-3 w-3" />
                </button>
                <input
                  v-model="num.marginBottom"
                  inputmode="numeric"
                  class="mono"
                  @blur="commitNum('marginBottom', num.marginBottom)"
                  @keydown.enter="onEnter"
                  @keydown.up.prevent="stepNum('marginBottom', 1)"
                  @keydown.down.prevent="stepNum('marginBottom', -1)"
                />
                <span class="ins-unit">mm</span>
                <button type="button" class="ins-step" title="増やす" @click="stepNum('marginBottom', 1)">
                  <Plus class="h-3 w-3" />
                </button>
              </div>
              <span v-else class="mono font-semibold tabular-nums">{{ geom.marginBottom }} mm</span>
            </div>
          </div>
        </section>

        <!-- ── 改ページ ── -->
        <section class="border-b">
          <button type="button" class="sec-head" @click="open.pagebreak = !open.pagebreak">
            <component :is="open.pagebreak ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
            <FileText class="h-3.5 w-3.5" /> 改ページ
          </button>
          <div v-show="open.pagebreak" class="px-4 pb-3">
            <!-- 編集モード: トグル / 表示のみ: 読み取り専用の状態行 -->
            <template v-if="editMode">
              <button
                v-for="it in PB_ITEMS"
                :key="it.key"
                type="button"
                class="pb-toggle"
                :class="cn(geom[it.key] && 'pb-on')"
                @click="togglePB(it.key)"
              >
                <component :is="it.icon" class="h-[15px] w-[15px]" />
                <span class="flex-1 text-left">{{ it.label }}</span>
                <span class="pb-state">{{ geom[it.key] ? 'ON' : 'OFF' }}</span>
              </button>
            </template>
            <template v-else>
              <div v-for="it in PB_ITEMS" :key="it.key" class="pb-readonly">
                <component :is="it.icon" class="h-[15px] w-[15px]" />
                <span class="flex-1 text-left">{{ it.label }}</span>
                <span class="pb-state" :class="geom[it.key] ? 'text-primary' : 'text-muted-foreground'">
                  {{ geom[it.key] ? 'ON' : 'OFF' }}
                </span>
              </div>
            </template>
          </div>
        </section>

        <!-- ── メモ(版を跨いで継続) ── -->
        <section class="border-b">
          <button type="button" class="sec-head" @click="open.memo = !open.memo">
            <component :is="open.memo ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
            <StickyNote class="h-3.5 w-3.5" /> メモ
            <span class="flex-1" />
            <Badge v-if="note" variant="secondary" class="h-[18px] py-0 text-[10.5px]">記入あり</Badge>
          </button>
          <div v-show="open.memo" class="px-4 pb-3.5">
            <textarea
              v-model="noteText"
              :disabled="!canNote"
              class="memo-area"
              rows="4"
              placeholder="このパーツへのメモ（版が変わっても継続）"
              @input="onNoteInput"
            />
            <p class="mt-1 text-[11px] text-muted-foreground">
              会社・ファンド単位で保存し、版（版種・基準日）が変わっても同じパーツに表示します。
            </p>
          </div>
        </section>

        <!-- ── 修正履歴 ── -->
        <section :class="editMode ? 'border-b' : ''">
          <button type="button" class="sec-head" @click="open.history = !open.history">
            <component :is="open.history ? ChevronDown : ChevronRight" class="h-3.5 w-3.5 opacity-70" />
            <History class="h-3.5 w-3.5" /> 修正履歴
            <span class="flex-1" />
            <Badge variant="secondary" class="h-[18px] py-0 text-[10.5px]">{{ history.length }} 件</Badge>
          </button>
          <div v-show="open.history" class="px-4 pb-3.5">
            <p v-if="history.length === 0" class="text-[12.5px] text-muted-foreground">変更履歴はまだありません。</p>
            <div v-else>
              <div
                v-for="(h, i) in history"
                :key="h.id"
                class="flex gap-2.5"
                :class="i < history.length - 1 ? 'pb-4' : ''"
              >
                <div class="flex flex-col items-center">
                  <span class="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" :class="i === 0 ? 'bg-primary' : 'bg-border'" />
                  <span v-if="i < history.length - 1" class="mt-0.5 w-0.5 flex-1 bg-border" />
                </div>
                <div class="flex-1">
                  <Badge
                    v-if="historySpansParts"
                    variant="secondary"
                    class="mb-0.5 h-[16px] py-0 text-[10px] font-normal"
                  >{{ partLabelOf(h.partKey) }}</Badge>
                  <div class="text-[12.5px] leading-snug text-foreground">{{ h.change }}</div>
                  <div class="mt-0.5 text-[11px] text-muted-foreground">{{ formatDateTime(h.timestamp) }} ・ {{ h.user }}</div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- ── アクションバー(並べ替え / 初期化 / 削除): 編集許可時のみ ── -->
      <div v-if="editMode" class="flex shrink-0 items-center gap-1 border-t px-3 py-2">
        <button type="button" class="act" title="上へ移動" :disabled="!canUp" @click="emit('move', -1)">
          <ChevronUp class="h-[15px] w-[15px]" />
        </button>
        <button type="button" class="act" title="下へ移動" :disabled="!canDown" @click="emit('move', 1)">
          <ChevronDown class="h-[15px] w-[15px]" />
        </button>
        <span class="flex-1" />
        <button type="button" class="act" title="配置を初期化" @click="emit('reset')">
          <RotateCcw class="h-[14px] w-[14px]" />
        </button>
        <button type="button" class="act act-danger" title="このパーツを削除" @click="emit('del')">
          <Trash2 class="h-[14px] w-[14px]" />
        </button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
/* 折りたたみセクションの見出し(クリックで開閉) */
.sec-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--muted-foreground);
  transition: background-color 0.12s;
}
.sec-head:hover {
  background: var(--accent);
}

/* ラベル + コントロールの 1 行 */
.ins-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 12.5px;
}

/* 数値入力(幅 / 余白)。両端に増減ステッパーを置き、中央に値 + 単位を据える */
.ins-num {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 1px;
  border-radius: 7px;
  background: var(--muted);
  padding: 0 2px;
}
.ins-num input {
  width: 40px;
  border: 0;
  background: transparent;
  text-align: center;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  outline: none;
  padding: 0;
}
.ins-num input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ins-unit {
  font-size: 10px;
  color: var(--muted-foreground);
}
/* 増減ボタン(クリック / 入力欄の上下キーと同じ刻み) */
.ins-step {
  display: inline-flex;
  height: 22px;
  width: 22px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--muted-foreground);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.ins-step:hover {
  background: var(--accent);
  color: var(--foreground);
}

/* メモ入力(版を跨ぐパーツ単位)。固定 UI スケールで常に読める(キャンバスズーム非依存) */
.memo-area {
  width: 100%;
  min-height: 84px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--muted);
  padding: 8px 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--foreground);
  outline: none;
}
.memo-area:focus {
  border-color: var(--primary);
  background: var(--background);
}
.memo-area:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 配置のセグメントボタン */
.seg {
  display: inline-flex;
  height: 28px;
  min-width: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: color-mix(in oklab, var(--foreground) 80%, transparent);
  transition: background-color 0.12s;
}
.seg:hover:not(:disabled) {
  background: var(--accent);
}
.seg:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.seg-on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.seg-on:hover {
  background: var(--primary);
}

/* 改ページのトグル(行全体) */
.pb-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 7px;
  padding: 7px 8px;
  margin-top: 2px;
  font-size: 12.5px;
  color: color-mix(in oklab, var(--foreground) 85%, transparent);
  transition: background-color 0.12s;
}
.pb-toggle:hover:not(:disabled) {
  background: var(--accent);
}
.pb-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pb-toggle.pb-on {
  background: var(--primary);
  color: var(--primary-foreground);
}
.pb-toggle.pb-on:hover {
  background: var(--primary);
}
/* 表示のみモードの改ページ状態(読み取り専用・トグル不可) */
.pb-readonly {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  margin-top: 2px;
  font-size: 12.5px;
  color: color-mix(in oklab, var(--foreground) 85%, transparent);
}
.pb-state {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

/* アクションバーのボタン */
.act {
  display: inline-flex;
  height: 30px;
  min-width: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: color-mix(in oklab, var(--foreground) 80%, transparent);
  transition: background-color 0.12s;
}
.act:hover:not(:disabled) {
  background: var(--accent);
}
.act:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.act-danger {
  color: var(--destructive);
}
.act-danger:hover {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
}
</style>
