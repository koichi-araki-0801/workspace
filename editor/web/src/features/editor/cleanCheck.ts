// =============================================================================
// cleanCheck.ts — 確定版との同一判定(編集を元に戻したら「未確定」を下ろす)
// =============================================================================
// 役割: 今の保存内容(本文と CSS)が確定版の正規形と同じなら、未確定(`dirty`)を下ろして後始末
// (autosave の取り消し・下書きの破棄。`useTemplateEditor.ts` が渡す)を呼ぶ。Undo や手戻しで元の
// 内容に戻ったのに未確定のまま下書きが残ると、プレビュー・申請が「変更あり」の経路を通り続ける。
// 本文は変更の通知の待ちのあとに 1 回だけ読み、番号の計算と共用する(`bodyReader` を
// `useEditorChangeView` へ渡す。大きい帳票では本文の直列化が数百 ms かかる)。

import type { Ref } from 'vue';
import type { ConfirmedCanonical } from '@/lib/confirmedCanonical';

export function createCleanCheck(ctx: {
  /** 確定版の正規形(GrapesJS が直列化した形)。作成経路・測れなかったときは null で、判定しない。 */
  canonical: () => ConfirmedCanonical | null;
  dirty: Ref<boolean>;
  readBody: () => string;
  readCss: () => string;
  /** 未確定を下ろしたあとの後始末(autosave の取り消し・下書きの破棄)。 */
  onClean: () => Promise<void>;
}) {
  /** 判定に本文が要るか。正規形があり、未確定のときだけ(それ以外は本文を読まない)。 */
  function wants(): boolean {
    return ctx.canonical() !== null && ctx.dirty.value;
  }

  /**
   * 確定版と同じなら未確定を下ろして後始末を呼び、true を返す。`body` は読み済みの本文(変更の
   * 通知の待ちのあとに読んだもの)で、無ければここで読む。CSS は本文より軽いのでここで読む。
   */
  async function settle(body?: string): Promise<boolean> {
    const base = ctx.canonical();
    if (!base || !ctx.dirty.value) return false;
    if ((body ?? ctx.readBody()) !== base.html || ctx.readCss() !== base.css) return false;
    ctx.dirty.value = false;
    await ctx.onClean();
    return true;
  }

  return {
    wants,
    settle,
    /** `useEditorChangeView` へ渡す、変更の通知の待ちのあとの本文の受け口。 */
    bodyReader: () => ({
      onBodyRead: (body: string) => void settle(body),
      wantsBodyRead: wants,
    }),
  };
}
