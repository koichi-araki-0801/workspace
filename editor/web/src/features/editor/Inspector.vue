<script setup lang="ts">
// =============================================================================
// Inspector.vue — 右ペイン(選択パーツの編集可能プロパティ + 修正履歴)
// =============================================================================
/**
 * 右ペイン: 選択パーツのプロパティを「編集可能」に提示し、修正履歴を併載するパネル。
 *
 * 編集 UI はここへ集約し、サイズ・配置 / 余白 / 改ページ / 修正履歴を
 * 「折りたたみ式セクション」(タブにしない)として縦積み表示する。
 * 幾何の編集ロジック(数値 clamp・配置・改ページ)も本コンポーネントが持つ。
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
  ChevronUp,
  Eye,
  FileText,
  History,
  PanelRight,
  PanelRightClose,
  RotateCcw,
  SplitSquareVertical,
  StickyNote,
  Table,
  Trash2,
  TrendingUp,
} from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { Tooltip } from '@/components/ui/overlays';
import StepperInput from '@/components/ui/StepperInput.vue';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type Align, clampMarginMm, clampWidthPct, type LayoutGeom, WIDTH_PCT_MAX } from './geom';
import InspectorSection from './InspectorSection.vue';
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
// `resetGeom` / `deletePart`)へそのまま委譲する。
const emit = defineEmits<{
  apply: [Partial<LayoutGeom>];
  move: [-1 | 1];
  reset: [];
  del: [];
  'update-note': [string];
  collapse: [];
}>();

const label = computed(() => props.part?.name ?? props.selected?.name ?? '');
const group = computed(() => props.part?.classification.minorClass ?? props.selected?.name ?? '');

// ── 0b. 交付版⇄全体版 自動同期の既定バッジ ──
// ポリシーの正典はパーツカタログ台帳の `同期既定` 列(変更はマスタメンテ経由)。ここでは
// 選択中のカタログパーツの現在値を表示するのみ。null(未判断)は同期されないことが
// 利用者に見えないと危険なので、warning で明示する。カタログ外パーツは常に同期対象外の
// ためバッジ自体を出さない。
const SYNC_BADGE: Record<string, { label: string; variant: 'success' | 'secondary' }> = {
  同期: { label: 'ペア自動同期', variant: 'success' },
  非同期: { label: 'ペア同期しない', variant: 'secondary' },
  交付版のみ: { label: '交付版のみ', variant: 'secondary' },
  全体版のみ: { label: '全体版のみ', variant: 'secondary' },
};
const syncBadge = computed(
  (): { label: string; variant: 'success' | 'secondary' | 'warning' } | null =>
    props.part
      ? (SYNC_BADGE[props.part.syncDefault ?? ''] ?? {
          label: 'ペア同期 未判断',
          variant: 'warning',
        })
      : null,
);

// ── 0c. 注記マスタ書き戻し(次回作成テンプレへの反映)の既定バッジ ──
// 正典はカタログ台帳の `次回反映既定` 列。null(未判断)はバッジ非表示 — ペア同期の
// 「未判断 warning」と非対称なのは、書き戻しがオプトイン運用で未設定が正常状態のため
// (大多数のパーツに warning が並ぶと本当に見るべき警告が埋もれる)。
const REFLECT_BADGE: Record<string, { label: string; variant: 'success' | 'secondary' }> = {
  反映: { label: '次回作成へ反映', variant: 'success' },
  非反映: { label: '次回作成へ反映しない', variant: 'secondary' },
};
const reflectBadge = computed(
  () => REFLECT_BADGE[props.part?.masterReflectDefault ?? ''] ?? null,
);

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
// ライブな幾何と同期しつつ、入力中の文字列を保持する。
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

function commitNum(key: 'widthPct' | 'marginTop' | 'marginBottom', raw: string) {
  if (!props.geom) return;
  let n = Math.round(Number(raw));
  if (Number.isNaN(n)) n = props.geom[key];
  n = key === 'widthPct' ? clampWidthPct(n) : clampMarginMm(n);
  num[key] = String(n);
  // 値が動いていない確定(入力欄を focus して blur しただけ)では emit しない。emit すると
  // 編集していないのに draft が生成され、`pushUndo` で Redo スタックまで消える。
  if (key === 'widthPct') {
    const align: Align =
      n >= WIDTH_PCT_MAX ? 'stretch' : props.geom.align === 'stretch' ? 'left' : props.geom.align;
    if (n === props.geom.widthPct && align === props.geom.align) return;
    emit('apply', { widthPct: n, align });
  } else {
    if (n === props.geom[key]) return;
    emit('apply', { [key]: n } as Partial<LayoutGeom>);
  }
}

// 入力中の値が数値として無効か(空 / 非数値)。blur 時に `commitNum` が元値へ戻すが、
// それまでは何が起きるか分かりにくいため、無効な間は入力欄を赤系にして気付けるようにする。
function numInvalid(key: 'widthPct' | 'marginTop' | 'marginBottom'): boolean {
  const raw = num[key].trim();
  return raw === '' || Number.isNaN(Number(raw));
}

// 数値の増減(ステッパーボタン / 上下キー)。現在のミラー値を起点に ±delta し、clamp と
// emit は `commitNum` に委譲する(幅は 1%、余白は 1mm 刻み)。
function stepNum(key: 'widthPct' | 'marginTop' | 'marginBottom', delta: number) {
  if (!props.geom) return;
  const cur = Math.round(Number(num[key]));
  const base = Number.isNaN(cur) ? props.geom[key] : cur;
  commitNum(key, String(base + delta));
}

// ── 4. Button 化した独自コンパクトボタンの共通クラス ──
// セグメント / アクション / 改ページトグルの各ボタンを Tailwind ユーティリティで組む。
// ghost variant の hover 文字色変化と基底の `[&_svg]:size-4` は打ち消す。
const SEG_CLASS =
  'h-7 w-auto min-w-[30px] rounded-[7px] p-0 text-foreground/80 hover:text-foreground/80 [&_svg]:size-[15px]';
const ON_CLASS = 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground';
const ACT_CLASS =
  'h-[30px] w-auto min-w-[30px] rounded-[7px] p-0 text-foreground/80 hover:text-foreground/80 disabled:opacity-35';
const PB_CLASS =
  'mt-0.5 h-auto w-full justify-start gap-2 rounded-[7px] px-2 py-[7px] text-[12.5px] font-normal text-foreground/85 hover:text-foreground/85 [&_svg]:size-[15px]';
</script>

<template>
  <aside class="flex w-[312px] shrink-0 flex-col overflow-hidden border-l bg-card">
    <div class="flex h-[46px] shrink-0 items-center gap-2 border-b px-4 text-[12.5px] font-bold">
      <span>プロパティ</span>
      <span class="flex-1" />
      <Badge v-if="selected && !editMode" variant="secondary" class="h-[19px] gap-1 py-0">
        <Eye class="h-[11px] w-[11px]" /> 表示のみ
      </Badge>
      <Tooltip text="右パネルを畳む">
        <Button
          variant="ghost"
          size="iconSm"
          class="text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="右パネルを畳む"
          @click="emit('collapse')"
        >
          <PanelRightClose class="h-4 w-4" />
        </Button>
      </Tooltip>
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
        <Badge v-if="syncBadge" :variant="syncBadge.variant" class="mt-1.5 h-[18px] py-0 text-[10.5px]">
          {{ syncBadge.label }}
        </Badge>
        <Badge v-if="reflectBadge" :variant="reflectBadge.variant" class="ml-1 mt-1.5 h-[18px] py-0 text-[10.5px]">
          {{ reflectBadge.label }}
        </Badge>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- ── サイズ・配置 ── -->
        <InspectorSection v-model:open="open.size" label="サイズ・配置" :icon="Table" class="border-b" body-class="px-4 pb-3">
          <div class="ins-row">
            <span class="text-muted-foreground">幅</span>
            <StepperInput
              v-if="editMode"
              v-model="num.widthPct"
              unit="%"
              :invalid="numInvalid('widthPct')"
              dec-label="幅を減らす"
              inc-label="幅を増やす"
              @commit="commitNum('widthPct', num.widthPct)"
              @step="stepNum('widthPct', $event)"
            />
            <span v-else class="mono font-semibold tabular-nums">{{ geom.widthPct }} %</span>
          </div>
          <!-- 横の配置: 幅 100% では効かないため、幅 < 100% のときだけ出す -->
          <div v-if="canAlign()" class="ins-row">
            <span class="text-muted-foreground">横の配置</span>
            <div v-if="editMode" class="flex gap-0.5">
              <Tooltip text="左寄せ">
                <Button variant="ghost" aria-label="左寄せ" :aria-pressed="geom.align === 'left'" :class="cn(SEG_CLASS, geom.align === 'left' && ON_CLASS)" @click="setAlign('left')">
                  <AlignLeft class="h-[15px] w-[15px]" />
                </Button>
              </Tooltip>
              <Tooltip text="中央">
                <Button variant="ghost" aria-label="中央" :aria-pressed="geom.align === 'center'" :class="cn(SEG_CLASS, geom.align === 'center' && ON_CLASS)" @click="setAlign('center')">
                  <AlignCenter class="h-[15px] w-[15px]" />
                </Button>
              </Tooltip>
              <Tooltip text="右寄せ">
                <Button variant="ghost" aria-label="右寄せ" :aria-pressed="geom.align === 'right'" :class="cn(SEG_CLASS, geom.align === 'right' && ON_CLASS)" @click="setAlign('right')">
                  <AlignRight class="h-[15px] w-[15px]" />
                </Button>
              </Tooltip>
            </div>
            <span v-else class="font-semibold">{{ alignLabel }}</span>
          </div>
          <!-- 左インデントは read-only(編集経路なし)。0mm は情報量ゼロなので隠す -->
          <div v-if="geom.indent > 0" class="ins-row">
            <span class="text-muted-foreground">左インデント</span>
            <span class="mono font-semibold tabular-nums">{{ geom.indent }} mm</span>
          </div>
        </InspectorSection>

        <!-- ── 余白 ── -->
        <InspectorSection v-model:open="open.margin" label="余白（前後の間隔）" :icon="TrendingUp" class="border-b" body-class="px-4 pb-3">
          <div class="ins-row">
            <span class="text-muted-foreground">上の余白</span>
            <StepperInput
              v-if="editMode"
              v-model="num.marginTop"
              unit="mm"
              :invalid="numInvalid('marginTop')"
              dec-label="上の余白を減らす"
              inc-label="上の余白を増やす"
              @commit="commitNum('marginTop', num.marginTop)"
              @step="stepNum('marginTop', $event)"
            />
            <span v-else class="mono font-semibold tabular-nums">{{ geom.marginTop }} mm</span>
          </div>
          <div class="ins-row">
            <span class="text-muted-foreground">下の余白</span>
            <StepperInput
              v-if="editMode"
              v-model="num.marginBottom"
              unit="mm"
              :invalid="numInvalid('marginBottom')"
              dec-label="下の余白を減らす"
              inc-label="下の余白を増やす"
              @commit="commitNum('marginBottom', num.marginBottom)"
              @step="stepNum('marginBottom', $event)"
            />
            <span v-else class="mono font-semibold tabular-nums">{{ geom.marginBottom }} mm</span>
          </div>
        </InspectorSection>

        <!-- ── 改ページ ── -->
        <InspectorSection v-model:open="open.pagebreak" label="改ページ" :icon="FileText" class="border-b" body-class="px-4 pb-3">
          <!-- 編集モード: トグル / 表示のみ: 読み取り専用の状態行 -->
          <template v-if="editMode">
            <Button
              v-for="it in PB_ITEMS"
              :key="it.key"
              variant="ghost"
              :class="cn(PB_CLASS, geom[it.key] && ON_CLASS)"
              @click="togglePB(it.key)"
            >
              <component :is="it.icon" class="h-[15px] w-[15px]" />
              <span class="flex-1 text-left">{{ it.label }}</span>
              <span class="pb-state">{{ geom[it.key] ? 'ON' : 'OFF' }}</span>
            </Button>
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
        </InspectorSection>

        <!-- ── メモ(会社・ファンド・基準日・版 単位) ── -->
        <InspectorSection v-model:open="open.memo" label="メモ" :icon="StickyNote" class="border-b" body-class="px-4 pb-3.5">
          <template #badge>
            <span class="flex-1" />
            <Badge v-if="note" variant="secondary" class="h-[18px] py-0 text-[10.5px]">記入あり</Badge>
          </template>
          <textarea
            v-model="noteText"
            :disabled="!canNote"
            class="memo-area"
            rows="4"
            placeholder="このパーツへのメモ（会社・ファンド・基準日・版ごと）"
            @input="onNoteInput"
          />
          <p class="mt-1 text-[11px] text-muted-foreground">
            このパーツへのメモを、会社・ファンド・基準日・版（版種）単位で保存します。
          </p>
        </InspectorSection>

        <!-- ── 修正履歴 ── -->
        <InspectorSection
          v-model:open="open.history"
          label="修正履歴"
          :icon="History"
          :class="editMode ? 'border-b' : ''"
          body-class="px-4 pb-3.5"
        >
          <template #badge>
            <span class="flex-1" />
            <Badge variant="secondary" class="h-[18px] py-0 text-[10.5px]">{{ history.length }} 件</Badge>
          </template>
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
        </InspectorSection>
      </div>

      <!-- ── アクションバー(並べ替え / 初期化 / 削除): 編集許可時のみ ── -->
      <div v-if="editMode" class="flex shrink-0 items-center gap-1 border-t px-3 py-2">
        <Tooltip text="上へ移動">
          <Button variant="ghost" :class="cn(ACT_CLASS, '[&_svg]:size-[15px]')" aria-label="上へ移動" :disabled="!canUp" @click="emit('move', -1)">
            <ChevronUp class="h-[15px] w-[15px]" />
          </Button>
        </Tooltip>
        <Tooltip text="下へ移動">
          <Button variant="ghost" :class="cn(ACT_CLASS, '[&_svg]:size-[15px]')" aria-label="下へ移動" :disabled="!canDown" @click="emit('move', 1)">
            <ChevronDown class="h-[15px] w-[15px]" />
          </Button>
        </Tooltip>
        <span class="flex-1" />
        <Tooltip text="配置を初期化">
          <Button variant="ghost" :class="cn(ACT_CLASS, '[&_svg]:size-[14px]')" aria-label="配置を初期化" @click="emit('reset')">
            <RotateCcw class="h-[14px] w-[14px]" />
          </Button>
        </Tooltip>
        <Tooltip text="このパーツを削除">
          <Button
            variant="ghost"
            :class="cn(ACT_CLASS, '[&_svg]:size-[14px] text-destructive hover:bg-destructive/12 hover:text-destructive')"
            aria-label="このパーツを削除"
            @click="emit('del')"
          >
            <Trash2 class="h-[14px] w-[14px]" />
          </Button>
        </Tooltip>
      </div>
    </template>
  </aside>
</template>

<style scoped>
/* ラベル + コントロールの 1 行 */
.ins-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 12.5px;
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

</style>
