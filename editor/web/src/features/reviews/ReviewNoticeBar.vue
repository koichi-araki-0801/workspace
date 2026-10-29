<script setup lang="ts">
// =============================================================================
// ReviewNoticeBar.vue — 承認タブの申請カードの注意を、業務の言葉の 1 行にまとめる通知バー
// =============================================================================
// 紙面だけでは確かめきれない変更(書式設定の変更・印刷用の書式・差分の打ち切り)を、
// 「⚠ 画面だけでは確認しきれない変更が N 件」の 1 行にまとめ、開くと業務の言葉で説明を出す。
// 承認者(事務担当者)に「テンプレの CSS」のような実装の言葉を見せないため。
// 項目を `v-if` で消すのは、その条件が偽のときだけにする。真の間は畳んでいても DOM に置く
// (畳むのは見た目だけ)。設計正典の「承認者が見る画面の完全性は 1 つの要件」を守るため。
// 書式設定の変更(`cssChanged`)は紙面の左右比較で見落としやすいので、いつも先頭に強調して出す。
import { computed } from 'vue';

const props = defineProps<{
  cssChanged: boolean;
  /**
   * 書式(CSS)が同じテンプレの基準日違いの文書と共有されている申請か(値入り HTML の申請)。
   * CSS はテンプレ単位なので、ある基準日の承認が他の基準日の見た目も変える。承認者はその基準日の
   * 文書しか見ていないので、効く範囲を言葉で補う。
   */
  sharedAcrossBaseDates: boolean;
  cssBefore: string;
  cssAfter: string;
  printOnlyCss: boolean;
  truncated: boolean;
  /** PDF 生成中か。多重クリック防止のためリンクボタンを disabled にする。 */
  pdfGenerating: boolean;
}>();

const emit = defineEmits<{ openPdf: [] }>();

const count = computed(
  () =>
    (props.cssChanged ? 1 : 0) +
    (props.printOnlyCss ? 1 : 0) +
    (props.truncated ? 1 : 0),
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
        <p class="font-medium">このテンプレートの書式設定も変更されています</p>
        <p v-if="sharedAcrossBaseDates" data-shared-base-dates class="mt-1 font-medium">この CSS は同じテンプレの他の基準日にも効きます</p>
        <p class="mt-1 text-xs text-amber-800">
          文字の大きさ・色・配置などの決まりが変更されました。
          紙面の左右（変更前・変更後）に差がないか、特に注意して確認してください。
        </p>
        <p class="mt-1 text-xs text-amber-800">
          ペアの版種（交付版⇔全体版）にも、ペア側で個別に直していない書式は承認のときに写ります。
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
          一部の書式は PDF にしたときだけ反映されます。紙面の「変更後（申請版）」は PDF と同じ仕組みで
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
        <p class="font-medium">変更が多すぎるため、文字の変更をすべては照合できませんでした</p>
        <p class="mt-1 text-xs text-amber-800">
          右欄の一覧と紙面の番号は、照合できた範囲だけです。この申請は最終確定できません。申請を分けてもらってください。
        </p>
      </li>
    </ol>
  </details>
</template>
