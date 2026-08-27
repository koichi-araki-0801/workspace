<script setup lang="ts">
// =============================================================================
// ReviewNoticeBar.vue — 精査画面の技術的警告を業務語 1 行へ集約する通知バー
// =============================================================================
// 旧画面はバナー 4 種(truncated / printOnlyCss / cssChanged / 行打ち切り)が個別に並び、
// 「ファンド共通 CSS」「語句単位の着色」等の実装語彙が承認者(事務担当者)へ直接出ていた。
// 本コンポーネントは全種を「⚠ 画面だけでは確認しきれない変更が N 件」の 1 行へ束ね、
// 展開で業務語の説明を出す。**該当項目を v-if で消すのは条件そのものが偽のときだけ**で、
// 真である限り DOM に常在させる(折りたたみは表示状態のみ) — 設計正典「承認者が見る画面の
// 完全性は 1 つの要件」の担保。書式設定(cssChanged)だけが「見た目比較に出ないかも
// しれない変更」なので常に先頭・強調とする。
import { computed } from 'vue';

const props = defineProps<{
  cssChanged: boolean;
  cssBefore: string;
  cssAfter: string;
  printOnlyCss: boolean;
  truncated: boolean;
  hiddenRowCount: number;
  /** PDF 生成中か。多重クリック防止のためリンクボタンを disabled にする。 */
  pdfGenerating: boolean;
}>();

const emit = defineEmits<{ openPdf: [] }>();

const count = computed(
  () =>
    (props.cssChanged ? 1 : 0) +
    (props.printOnlyCss ? 1 : 0) +
    (props.truncated ? 1 : 0) +
    (props.hiddenRowCount > 0 ? 1 : 0),
);
</script>

<template>
  <details
    v-if="count > 0"
    open
    class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
  >
    <summary class="cursor-pointer font-medium">
      ⚠ 画面だけでは確認しきれない変更が {{ count }} 件あります（開いて確認）
    </summary>
    <ol class="mt-2 space-y-3">
      <li v-if="cssChanged" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">このファンドの書式設定も変更されています</p>
        <p class="mt-1 text-xs text-amber-800">
          文字の大きさ・色・配置などの決まりが変更されました。このファンドの
          <strong>他の版種（全体版など）の見た目にも影響する</strong>可能性があります。
          左右の見た目比較に差がないか、特に注意して確認してください。
        </p>
        <details class="mt-1 text-xs">
          <summary class="cursor-pointer text-amber-900 underline">
            書式の変更内容を表示（変更前｜変更後）
          </summary>
          <div class="mt-2 grid gap-3 md:grid-cols-2">
            <figure class="min-w-0 space-y-1">
              <figcaption>変更前（現在の本番）</figcaption>
              <pre class="max-h-64 overflow-auto rounded border bg-white p-2 text-foreground"><code>{{ cssBefore }}</code></pre>
            </figure>
            <figure class="min-w-0 space-y-1">
              <figcaption>変更後（申請された内容）</figcaption>
              <pre class="max-h-64 overflow-auto rounded border bg-white p-2 text-foreground"><code>{{ cssAfter }}</code></pre>
            </figure>
          </div>
        </details>
      </li>
      <li v-if="printOnlyCss" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">画面では確認できない印刷用の書式が含まれています</p>
        <p class="mt-1 text-xs text-amber-800">
          一部の書式は PDF にしたときだけ反映されます。右の「修正後」は PDF と同じ仕組みで
          表示していますが、心配な場合は
          <button
            type="button"
            data-open-pdf
            class="underline disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="pdfGenerating"
            @click="emit('openPdf')"
          >
            {{ pdfGenerating ? 'PDFを作成中…' : 'PDF を開いて確認' }}
          </button>
          してください。
        </p>
      </li>
      <li v-if="truncated" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">「文字の変更の一覧」に表示しきれなかった項目があります</p>
        <p class="mt-1 text-xs text-amber-800">
          変更がとても多いため、一覧には全件を表示できていません。
          <strong>左右の見た目比較ではすべてのページを確認できます</strong>ので、そちらで
          全ページをご確認ください。
        </p>
      </li>
      <li v-if="hiddenRowCount > 0" data-notice-item class="border-t border-amber-200 pt-2">
        <p class="font-medium">変更箇所が多すぎるため、一覧の一部を表示できません</p>
        <p class="mt-1 text-xs text-amber-800">
          残り {{ hiddenRowCount }} 件が一覧に出ていません。左右の見た目比較で確認するか、
          編集者に<strong>申請をいくつかに分けて出し直す</strong>よう依頼してください。
        </p>
      </li>
    </ol>
  </details>
</template>
