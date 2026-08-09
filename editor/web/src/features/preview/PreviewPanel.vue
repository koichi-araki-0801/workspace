<script setup lang="ts">
// =============================================================================
// PreviewPanel.vue — 隔離 iframe 内の vivliostyle へ命令を出し, 状態を親へ上げる
// =============================================================================
// ページ送り/ズームの操作 UI は持たず, 状態は `state` イベントで親(`PreviewView`)へ上げ,
// 命令は `defineExpose` で公開する。UI は編集画面(`EditorTopBar`)と揃えて上部バーへ集約する。
//
// **組版は本体 document ではなく opaque オリジンの iframe の中で行う。** テンプレの JS は
// 正当なコンテンツなので動かすが、動かす場所をアプリのオリジンから切り離す — これが
// 「除去でなく隔離」の実装で、iframe は `sandbox="allow-scripts"`(`allow-same-origin` を
// 付けない)で開く。中身のビューアとブートはサーバ配信のホストページ
// (`server/src/vivliostyle/previewHost.ts`)が持ち、その経路だけの CSP で inline JS を許す。
// srcdoc / blob では親の CSP を継承してテンプレ inline JS が原理的に動かせないため、
// 実 URL のホストページであることが要件になる(理由は同ファイル冒頭)。
//
// 親は子の DOM を一切読まない(`allow-same-origin` が無いので読めない)。命令も状態も
// `@editor/shared` の postMessage 契約(`preview/hostProtocol.ts`)を通る。フィット計算と
// `ResizeObserver` 相当は**子側で完結**しており、親へは表示用の zoom 値だけが返る。
import {
  PREVIEW_HOST_URL,
  PREVIEW_MSG_CMD,
  PREVIEW_MSG_DOC,
  PREVIEW_MSG_ERROR,
  PREVIEW_MSG_READY,
  PREVIEW_MSG_STATE,
  type PreviewCommand,
  type PreviewHostState,
  unexpected,
} from '@editor/shared';
import { Loader2 } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { logError } from '@/lib/appError';
import { selfContainPreviewDoc } from '@/lib/previewSelfContain';

const props = defineProps<{ html: string }>();

/** 親(上部バー)へ渡すページ送り/ズーム状態のスナップショット。 */
const emit = defineEmits<{
  state: [
    {
      currentPage: number;
      pageCount: number;
      atFirst: boolean;
      atLast: boolean;
      zoom: number;
      /** vivliostyle 描画中(= ズーム/ページ送り可)。iframe フォールバック時は false。 */
      vivlioReady: boolean;
    },
  ];
}>();

const hostUrl = PREVIEW_HOST_URL;

const frame = ref<HTMLIFrameElement>();
const fallbackFrame = ref<HTMLIFrameElement>();
const useFallback = ref(false);
const rendering = ref(false);
// 子から受けた状態のミラー。親は数値を表示するだけで、実位置の権威は常に子側にある。
const nav = ref<PreviewHostState>({
  currentPage: 1,
  pageCount: 0,
  atFirst: true,
  atLast: false,
  zoom: 1,
  ready: false,
});
// 子の boot 完了。未完了の間に届いた文書は保留し、ready 受信時に送る。
const hostReady = ref(false);

/**
 * 子から `ready` も状態通知も来ない場合の保険。ホストページの配信失敗(認証切れ・
 * バンドル欠落)やブラウザの sandbox 制約など、子が沈黙する形の失敗は親からは
 * 区別できないため、時間で切ってフォールバック表示へ倒す。
 */
const HOST_BOOT_TIMEOUT_MS = 15_000;
/** 組版が終わらない場合のローダー強制解除。 */
const RENDER_LOADER_FAILSAFE_MS = 30_000;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let loaderFailsafe: ReturnType<typeof setTimeout> | null = null;

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t !== null) clearTimeout(t);
  return null;
}

function emitState() {
  emit('state', {
    currentPage: nav.value.currentPage,
    pageCount: nav.value.pageCount,
    atFirst: nav.value.atFirst,
    atLast: nav.value.atLast,
    zoom: nav.value.zoom,
    vivlioReady: !useFallback.value,
  });
}

/**
 * 素の iframe 表示へ退避する。vivliostyle が起動しない/組版が壊れた場合でも、
 * プレビュー自体は機能し続ける(ページ送りとズームは失われる)。
 */
function fallback(reason: string) {
  if (useFallback.value) return;
  logError(unexpected(`プレビューの組版に失敗したため簡易表示へ切り替えました: ${reason}`));
  useFallback.value = true;
  rendering.value = false;
  bootTimer = clearTimer(bootTimer);
  loaderFailsafe = clearTimer(loaderFailsafe);
  if (fallbackFrame.value) fallbackFrame.value.srcdoc = props.html;
  emitState();
}

/**
 * 子へ 1 通送る。`targetOrigin` は `'*'` 固定 — opaque オリジンの子に具体的なオリジンを
 * 指定する手段は無い(指定すると配送されない)。運ぶのはこちらが組み立てた文書と
 * 命令だけで、子へ渡して困る情報は含まない。
 */
function postToHost(message: Record<string, unknown>) {
  frame.value?.contentWindow?.postMessage(message, '*');
}

/** 進行中の自己完結化を識別する連番。文書が続けて変わったとき、古い結果を子へ送らない。 */
let sendSeq = 0;

function sendDoc() {
  if (!hostReady.value || useFallback.value) return;
  loaderFailsafe = clearTimer(loaderFailsafe);
  rendering.value = props.html !== '';
  const seq = ++sendSeq;
  if (props.html === '') {
    postToHost({ type: PREVIEW_MSG_DOC, html: '' });
    emitState();
    return;
  }
  // 子は opaque オリジンでサブリソース要求にセッション cookie が付かない(SameSite=Lax)。
  // テンプレ JS・フォントは**親のここで**文書へ埋めてから渡す(`previewSelfContain.ts`)。
  // 失敗時は原文のまま送る = 認証オフ環境なら子の相対参照が今までどおり解決される。
  // 加工は表示境界限定で、申請へ保存される `previewDoc`/`filledHtml` には触れない。
  void selfContainPreviewDoc(props.html)
    .catch(() => props.html)
    .then((html) => {
      if (seq !== sendSeq || !hostReady.value || useFallback.value) return;
      postToHost({ type: PREVIEW_MSG_DOC, html });
    });
  // 子が COMPLETE へ到達しない非同期失敗への保険。組版自体は継続しうるので、
  // フォールバックへは倒さずローダーだけ解除する。
  loaderFailsafe = setTimeout(() => {
    loaderFailsafe = null;
    if (!rendering.value) return;
    rendering.value = false;
    logError(unexpected('プレビューの組版が時間内に完了しないため、ローダーを強制解除しました'));
    emitState();
  }, RENDER_LOADER_FAILSAFE_MS);
}

/**
 * 子からの通知を受ける。**発信元の検証は `event.source` と `contentWindow` の同一性で行う。**
 * opaque オリジンの子から届くメッセージの `origin` は `'null'` で、これは他の任意の
 * sandbox フレームとも一致するため識別に使えない(`useIframeAutoFit.ts` と同じ作法)。
 */
function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const data = e.data as { type?: unknown; state?: unknown; message?: unknown } | null;
  if (!data || typeof data.type !== 'string') return;
  if (data.type === PREVIEW_MSG_READY) {
    bootTimer = clearTimer(bootTimer);
    hostReady.value = true;
    sendDoc();
    return;
  }
  if (data.type === PREVIEW_MSG_STATE) {
    const s = data.state as Partial<PreviewHostState> | null;
    if (!s) return;
    nav.value = {
      currentPage: Number(s.currentPage) || 1,
      pageCount: Number(s.pageCount) || 0,
      atFirst: s.atFirst !== false,
      atLast: s.atLast === true,
      zoom: Number(s.zoom) || 1,
      ready: s.ready === true,
    };
    if (nav.value.ready) {
      loaderFailsafe = clearTimer(loaderFailsafe);
      rendering.value = false;
    }
    emitState();
    return;
  }
  if (data.type === PREVIEW_MSG_ERROR) {
    fallback(typeof data.message === 'string' ? data.message : '不明なエラー');
  }
}

/** iframe の `load`。ホストページが表示されなかった場合の切り分け用に boot 期限を張る。 */
function onFrameLoad() {
  bootTimer = clearTimer(bootTimer);
  if (hostReady.value) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    if (!hostReady.value) fallback('ビューアの起動確認が取れませんでした');
  }, HOST_BOOT_TIMEOUT_MS);
}

const send = (cmd: PreviewCommand, page?: number) => {
  if (useFallback.value) return;
  postToHost({ type: PREVIEW_MSG_CMD, cmd, ...(page === undefined ? {} : { page }) });
};

// `defineExpose` の 6 メソッドは親(`PreviewView`)の契約。中身が postMessage になっても
// 形は変えない(親は無改修で成立する)。現在ページ等は自前で進めず、子の `nav` 通知で反映する。
function prevPage() {
  send('prevPage');
}
function nextPage() {
  send('nextPage');
}
function goToPage(n: number) {
  send('goToPage', n);
}
function zoomIn() {
  send('zoomIn');
}
function zoomOut() {
  send('zoomOut');
}
function fit() {
  send('fit');
}

watch(
  () => props.html,
  () => {
    if (useFallback.value) {
      if (fallbackFrame.value) fallbackFrame.value.srcdoc = props.html;
      return;
    }
    rendering.value = props.html !== '';
    sendDoc();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('message', onMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  bootTimer = clearTimer(bootTimer);
  loaderFailsafe = clearTimer(loaderFailsafe);
});

defineExpose({ prevPage, nextPage, goToPage, zoomIn, zoomOut, fit });
</script>

<template>
  <div class="relative h-full w-full overflow-hidden bg-canvas-backdrop">
    <div
      v-if="rendering"
      class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/70 text-sm text-muted-foreground"
    >
      <Loader2 class="h-4 w-4 animate-spin" /> プレビューを生成中…
    </div>
    <!-- 組版を行う隔離フレーム。中身はサーバ配信のビューアホストページで, テンプレ本文は
         postMessage で渡す。`allow-same-origin` は付けない(付けると sandbox が事実上無効に
         なり、隔離そのものが消える)。親はこのフレームの中を読まない。 -->
    <iframe
      v-show="!useFallback"
      ref="frame"
      :src="hostUrl"
      sandbox="allow-scripts"
      class="h-full w-full border-0"
      title="プレビュー"
      @load="onFrameLoad"
    ></iframe>
    <!-- vivliostyle 起動/組版が失敗した時の素の表示。中身はテンプレ本文で、テンプレの JS は
         正当なコンテンツなので `allow-scripts` で動かし、`allow-same-origin` は付けない。 -->
    <iframe
      v-show="useFallback"
      ref="fallbackFrame"
      sandbox="allow-scripts"
      class="h-full w-full border-0 bg-white"
      title="プレビュー(簡易表示)"
    ></iframe>
  </div>
</template>
