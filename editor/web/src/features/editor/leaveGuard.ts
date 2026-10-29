// =============================================================================
// leaveGuard.ts — 編集画面を離れる前の保存と、保存できなかったときの確認
// =============================================================================
// `useTemplateEditor.ts` の `onBeforeRouteLeave` から呼ぶ。route を経ないアンマウント(タブを
// 閉じる・再読込)は対象外で、そちらは `beforeunload` の警告が受け持つ。
import { confirm } from '@/components/ui/confirm';

/**
 * 未保存の変更(debounce 待ちを含む)を保存してから離れてよいかを返す。保存できなければ
 * 「離れる / 留まる」を確かめる。`flush` は canvas を読むので、GrapesJS の破棄より前に呼ぶこと
 * (route の離脱ガードはアンマウントより先に走るので、そこから呼べば満たされる)。
 *
 * `toLogin` はログイン画面へ移されるとき(セッション切れの転送やログアウト)。保存は試みるが、
 * 結果によらず確認せずに離れる — ログインし直すまで保存はできないので、留まらせても
 * 未認証の編集画面に閉じ込めるだけになる。
 */
export async function leaveAfterSave(
  flush: () => Promise<boolean>,
  { toLogin = false }: { toLogin?: boolean } = {},
  ask: typeof confirm = confirm,
): Promise<boolean> {
  if ((await flush()) || toLogin) return true;
  return ask({
    title: '変更を保存できませんでした',
    description:
      'このまま離れると、最後の変更が下書きに残りません。留まって「再試行」で保存し直すこともできます。',
    confirmLabel: '離れる',
    cancelLabel: '留まる',
    variant: 'destructive',
  });
}
