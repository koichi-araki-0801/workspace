<script setup lang="ts">
// =============================================================================
// Inspector.vue — 右ペイン(選択パーツの編集可能プロパティ + 修正履歴)
// =============================================================================
/**
 * 右ペイン: 選択パーツのプロパティを「編集可能」に提示し、修正履歴を併載するパネル。
 *
 * 編集 UI はここへ集約し、サイズ・配置 / 余白 / 改ページ / 修正履歴を
 * 「折りたたみ式セクション」(タブにしない)として縦積み表示する。
 * 幾何の編集ロジック(数値 clamp・配置・改ページ)も本コンポーネントが持つ。前後の改ページは
 * inline style ではなくパーツの前後の区切り(`div.pagebreak`)の挿入・削除なので、`apply` ではなく
 * `pagebreak` で知らせる(`partBreak.ts`)。区切りの帯そのものを選んでいるときは、幾何も改ページも
 * 持たないので編集の段を出さない(帯は Delete で消す)。
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
  MessageSquare,
  PanelRightClose,
  RotateCcw,
  SplitSquareVertical,
  Table,
  Trash2,
  TrendingUp,
} from '@lucide/vue';
import { computed, reactive, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { Tooltip } from '@/components/ui/overlays';
import StepperInput from '@/components/ui/StepperInput.vue';
import { formatDateTime, formatDateTimeShort } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type Align, alignForWidth, clampMarginMm, clampWidthPct, type LayoutGeom, WIDTH_PCT_MAX } from './geom';
import type { HistoryGroup, RejectedReason } from './historyGroups';
import InspectorSection from './InspectorSection.vue';
import type { BreakEdge } from './partBreak';
import type { SelectedInfo } from './useGrapes';

const props = defineProps<{
  selected: SelectedInfo | null;
  part: PartCatalogItem | null;
  geom: LayoutGeom | null;
  /**
   * 選んだ要素が属するパーツの前後に改ページがあるか。null は区切りを置けない選択(固めた範囲の
   * 包みなど)で、前後の改ページを押せなくする。
   */
  partBreak: { before: boolean; after: boolean } | null;
  history: PartHistoryEntry[];
  /** 全パーツ横断表示(未選択時)で各履歴行のパーツを示すラベル(`partKey` → `ページN・パーツM`)。 */
  partLabels: Map<string, string>;
  /** 右ペインの表示(プロパティ / コメント)。切替の状態は `EditorView` が持つ。 */
  paneTab: 'props' | 'comments';
  /** 未対応コメントの件数(切替タブのバッジ)。 */
  commentCount: number;
  editMode: boolean;
  canUp: boolean;
  canDown: boolean;
  /** 未選択のときの修正履歴。変更の番号ごとの見出し(`historyGroups.ts`)。 */
  historyGroups: HistoryGroup[];
  /** 選択中のパーツの変更の番号(差分が無ければ null)・名前・キー(`title` のページN・パーツM用)。 */
  selectedNo: number | null;
  selectedName: string;
  selectedKey: string | null;
  /** 選択中のパーツの、前回の申請の却下の理由(`useRejectedReasons.ts`)。無ければ null。 */
  selectedRejected?: RejectedReason | null;
}>();

// 編集操作は `useTemplateEditor.ts` のハンドラ(`applyGeomEdit` / `setPartBreak` / `moveSelected` /
// `resetGeom` / `deletePart`)へそのまま委譲する。
const emit = defineEmits<{
  apply: [Partial<LayoutGeom>];
  pagebreak: [{ edge: BreakEdge; on: boolean }];
  move: [-1 | 1];
  reset: [];
  del: [];
  'pane-tab': ['props' | 'comments'];
  collapse: [];
  'select-part': [key: string];
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
  return props.partLabels.get(partKey) ?? '削除済みパーツ';
}

// ── 0d. 未選択の見出しごとの履歴 ──
/** 未選択の全パーツ表示で、見出しごとに最初に出す件数。残りは「さらに N 件を表示」で開く。 */
const HISTORY_PREVIEW = 5;
/** 開いた見出し(見出しごとに持つ)。 */
const expanded = reactive(new Set<string>());
const headingId = (g: HistoryGroup): string => `${g.key}:${g.removed}`;
const visibleEntries = (g: HistoryGroup): PartHistoryEntry[] =>
  expanded.has(headingId(g)) ? g.entries : g.entries.slice(0, HISTORY_PREVIEW);
/**
 * 選べない見出し(削除・紙面外)はフォーカスを残したまま押下を無視し、理由を読み上げに載せる。
 * 理由は中身(番号・名前)の後ろへ読み上げ用の文字で足す。`aria-label` にすると中身の
 * 「変更 N」を上書きする。
 */
function headingReason(g: HistoryGroup): string | null {
  if (g.removed) return '。削除したパーツのため選べません';
  if (g.offCanvas) return '。現在の紙面に無いため選べません';
  return null;
}
/** 却下の理由の枠の見出し。理由の本文は `{{ }}` でエスケープして描く(`v-html` を使わない)。 */
function rejectedHeading(r: RejectedReason): string {
  return `却下の理由（${r.decidedBy}・${formatDateTimeShort(r.decidedAt)}）`;
}
function onHeadingClick(g: HistoryGroup): void {
  if (g.removed || g.offCanvas) return;
  emit('select-part', g.key);
}

// ── 1. 折りたたみ状態 ──
// 既定は「閲覧」相当(編集セクションを畳み履歴を開く)。`editMode` 連動で切り替える。
const open = reactive({ size: false, margin: false, pagebreak: false, history: true });
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

// ── 3. 編集ハンドラ ──
const canAlign = () => !!props.geom && props.geom.widthPct < 100;

// 「表示のみ」モードで配置を値表示するための日本語ラベル(`canAlign()` 内のみ呼ぶ想定)。
const ALIGN_LABEL: Record<Align, string> = {
  left: '左寄せ',
  center: '中央',
  right: '右寄せ',
  stretch: '全幅',
};
// 横の配置の切替ボタン(幅 < 100% のときだけ出る 3 択。`stretch` は幅 100% の状態なので含めない)。
const ALIGN_BUTTONS = [
  { value: 'left', icon: AlignLeft },
  { value: 'center', icon: AlignCenter },
  { value: 'right', icon: AlignRight },
] as const;
const alignLabel = computed(() => (props.geom ? ALIGN_LABEL[props.geom.align] : ''));

// 改ページの 3 項目(編集 toggle / 表示のみの読み取り行で共有)。前後は区切りの状態
// (`partBreak`)、「ページ内で分割しない」は inline style の幾何(`geom`)から読む。
const PB_ITEMS = [
  { key: 'before', icon: ArrowUpToLine, label: '前で改ページ' },
  { key: 'after', icon: ArrowDownToLine, label: '後で改ページ' },
  { key: 'keepTogether', icon: SplitSquareVertical, label: 'ページ内で分割しない' },
] as const;
type PbKey = (typeof PB_ITEMS)[number]['key'];

function pbOn(key: PbKey): boolean {
  return key === 'keepTogether' ? !!props.geom?.keepTogether : !!props.partBreak?.[key];
}

function pbDisabled(key: PbKey): boolean {
  return key !== 'keepTogether' && !props.partBreak;
}

function setAlign(align: Align) {
  if (props.editMode && canAlign()) emit('apply', { align });
}

function togglePB(key: PbKey) {
  if (!props.editMode || !props.geom) return;
  if (key === 'keepTogether') emit('apply', { keepTogether: !props.geom.keepTogether });
  else if (props.partBreak) emit('pagebreak', { edge: key, on: !props.partBreak[key] });
}

function commitNum(key: 'widthPct' | 'marginTop' | 'marginBottom', raw: string) {
  if (!props.geom) return;
  // `Number('')` は 0 になり下限へ丸められてしまうため、空 / 空白は非数値として扱う。
  const t = raw.trim();
  let n = t === '' ? Number.NaN : Math.round(Number(t));
  if (Number.isNaN(n)) n = props.geom[key];
  n = key === 'widthPct' ? clampWidthPct(n) : clampMarginMm(n);
  num[key] = String(n);
  // 値が動いていない確定(入力欄を focus して blur しただけ)では emit しない。emit すると
  // 編集していないのに draft が生成され、`pushUndo` で Redo スタックまで消える。
  if (key === 'widthPct') {
    const align: Align = alignForWidth(n, WIDTH_PCT_MAX, props.geom.align);
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
    <div class="flex h-[46px] shrink-0 items-center gap-1 border-b px-2 text-[12.5px] font-bold">
      <button
        type="button"
        class="pane-tab"
        :class="paneTab === 'props' ? 'pane-tab-active' : ''"
        data-pane-tab="props"
        :aria-pressed="paneTab === 'props'"
        @click="emit('pane-tab', 'props')"
      >
        プロパティ
      </button>
      <button
        type="button"
        class="pane-tab"
        :class="paneTab === 'comments' ? 'pane-tab-active' : ''"
        data-pane-tab="comments"
        :aria-pressed="paneTab === 'comments'"
        @click="emit('pane-tab', 'comments')"
      >
        <MessageSquare class="h-3.5 w-3.5" /> コメント
        <Badge v-if="commentCount > 0" variant="warning" class="h-[16px] py-0 text-[9.5px]">{{ commentCount }}</Badge>
      </button>
      <span class="flex-1" />
      <Badge v-if="paneTab === 'props' && selected && !editMode" variant="secondary" class="h-[19px] gap-1 py-0">
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

    <div v-if="paneTab === 'comments'" class="flex min-h-0 flex-1 flex-col">
      <slot name="comments" />
    </div>

    <!-- 未選択: 全パーツの修正履歴を変更の番号ごとの見出しで並べる -->
    <div v-else-if="!selected || !geom" class="flex-1 overflow-y-auto px-4 py-3">
      <h3 class="mb-2 text-[12.5px] font-bold text-foreground">修正履歴（全パーツ）</h3>
      <p class="mb-3 rounded-md border border-dashed px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        パーツを選ぶと、そのパーツの設定と履歴だけを出します
      </p>
      <p v-if="historyGroups.length === 0" class="text-[12.5px] text-muted-foreground">変更履歴はまだありません。</p>
      <template v-for="(g, gi) in historyGroups" :key="`${g.key}:${g.removed}`">
        <p
          v-if="g.offCanvas && !historyGroups[gi - 1]?.offCanvas"
          class="mb-1 mt-3 text-[11.5px] font-bold text-muted-foreground"
          data-off-canvas-heading
        >現在の紙面に無いパーツ</p>
        <section class="mb-3" :data-history-group="g.key">
          <h4 class="m-0">
            <button
              type="button"
              class="relative flex w-full items-center gap-1.5 whitespace-nowrap rounded px-1 py-1 text-left"
              :class="g.removed || g.offCanvas ? 'cursor-default' : 'hover:bg-muted'"
              :data-history-heading="g.key"
              :aria-disabled="g.removed || g.offCanvas ? 'true' : undefined"
              @click="onHeadingClick(g)"
            >
              <!-- 丸は見た目だけ。番号は読み上げ用の文字で渡す(役割の無い span の aria-label は
                   支援技術に無視されうる)。読み上げ用の文字(`sr-only`)は absolute なので、ボタンを
                   relative にして包む(包まないと履歴の下端の外に置かれ、文書全体が縦に伸びる) -->
              <template v-if="g.no !== null">
                <span class="no-pill" aria-hidden="true">{{ g.no }}</span>
                <span class="sr-only">変更 {{ g.no }}</span>
              </template>
              <span class="min-w-0 truncate text-[12.5px] font-bold text-foreground">{{ g.name }}</span>
              <span v-if="headingReason(g)" class="sr-only">{{ headingReason(g) }}</span>
            </button>
          </h4>
          <div v-if="g.rejected" class="rejected-box mx-1 mb-1" data-rejected-reason>
            <div class="rejected-head">{{ rejectedHeading(g.rejected) }}</div>
            <p class="rejected-body">{{ g.rejected.reason }}</p>
          </div>
          <!-- 履歴が無いことは、削除の見出しと却下の理由の枠があるときは書かない(枠と並べると、理由が
               あるのに「何も無い」と読める) -->
          <p v-if="g.entries.length === 0 && !g.removed && !g.rejected" class="px-1 text-[12px] text-muted-foreground">このパーツの修正履歴はありません</p>
          <div v-for="h in visibleEntries(g)" :key="h.id" class="px-1 py-1">
            <div class="text-[12.5px] leading-snug text-foreground">{{ h.change }}</div>
            <div class="mt-0.5 text-[11px] text-muted-foreground">{{ formatDateTime(h.timestamp) }} ・ {{ h.user }}</div>
          </div>
          <button
            v-if="g.entries.length > HISTORY_PREVIEW && !expanded.has(headingId(g))"
            type="button"
            class="px-1 text-[12px] text-primary hover:underline"
            data-history-more
            @click="expanded.add(headingId(g))"
          >さらに {{ g.entries.length - HISTORY_PREVIEW }} 件を表示</button>
        </section>
      </template>
    </div>

    <template v-else>
      <!-- 選択パーツの識別情報(常に表示、折りたたみ不可) -->
      <div class="border-b bg-primary-soft/50 px-4 py-3">
        <div class="mb-1 text-[11px] text-muted-foreground">選択中のパーツ</div>
        <div
          class="relative flex items-center gap-1.5 whitespace-nowrap"
          data-selected-part
          :title="selectedKey ? (partLabels.get(selectedKey) ?? undefined) : undefined"
        >
          <template v-if="selectedNo !== null">
            <span class="no-pill" aria-hidden="true">{{ selectedNo }}</span>
            <span class="sr-only">変更 {{ selectedNo }}</span>
          </template>
          <span class="min-w-0 truncate text-sm font-bold text-foreground">{{ selectedName || label }}</span>
        </div>
        <div v-if="selectedRejected" class="rejected-box mt-1.5" data-rejected-reason>
          <div class="rejected-head">{{ rejectedHeading(selectedRejected) }}</div>
          <p class="rejected-body">{{ selectedRejected.reason }}</p>
        </div>
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
        <!-- 区切りの帯を選んでいるときは、幾何と改ページの段を出さない -->
        <template v-if="!selected.isPagebreak">
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
              <Tooltip v-for="opt in ALIGN_BUTTONS" :key="opt.value" :text="ALIGN_LABEL[opt.value]">
                <Button variant="ghost" :aria-label="ALIGN_LABEL[opt.value]" :aria-pressed="geom.align === opt.value" :class="cn(SEG_CLASS, geom.align === opt.value && ON_CLASS)" @click="setAlign(opt.value)">
                  <component :is="opt.icon" class="h-[15px] w-[15px]" />
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
              :class="cn(PB_CLASS, pbOn(it.key) && ON_CLASS)"
              :disabled="pbDisabled(it.key)"
              @click="togglePB(it.key)"
            >
              <component :is="it.icon" class="h-[15px] w-[15px]" />
              <span class="flex-1 text-left">{{ it.label }}</span>
              <span class="pb-state">{{ pbOn(it.key) ? 'ON' : 'OFF' }}</span>
            </Button>
          </template>
          <template v-else>
            <div v-for="it in PB_ITEMS" :key="it.key" class="pb-readonly">
              <component :is="it.icon" class="h-[15px] w-[15px]" />
              <span class="flex-1 text-left">{{ it.label }}</span>
              <span class="pb-state" :class="pbOn(it.key) ? 'text-primary' : 'text-muted-foreground'">
                {{ pbOn(it.key) ? 'ON' : 'OFF' }}
              </span>
            </div>
          </template>
        </InspectorSection>
        </template>

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
/* 前回の申請の却下の理由(読み取り専用)。却下の色は承認タブの判定と同じ固定色 `#c0392b`。 */
.rejected-box {
  border: 1px solid #c0392b;
  border-radius: 6px;
  background: color-mix(in srgb, #c0392b 6%, transparent);
  padding: 6px 8px;
}
.rejected-head {
  color: #c0392b;
  font-size: 11.5px;
  font-weight: 700;
}
.rejected-body {
  margin-top: 2px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
}
/* 変更の番号の丸。紙面の目印(`EditorView.vue` の `.chg-mark`)と同じ色
   (`index.css` の `--change-mark`) */
.no-pill {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 4px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: var(--change-mark);
  border-radius: 10px;
}
/* ラベル + コントロールの 1 行 */
.ins-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 12.5px;
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

.pane-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--muted-foreground);
}
.pane-tab:hover {
  background: var(--muted);
}
.pane-tab-active {
  color: var(--foreground);
  background: var(--primary-soft);
}
</style>
