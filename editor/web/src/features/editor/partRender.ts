// =============================================================================
// partRender.ts — カタログのパーツ(Jinja)を挿入の直前に経路ごとの値で描く
// =============================================================================
// `useGrapes.ts` の `insertPart` は経路を知らないので、描画は呼び出し側(`useTemplateEditor.ts` の
// `onPartInsert`)がここで行い、描いた HTML を渡す。2 系統の原則(設計正典「中核原則」)に沿って、
//   - 作成タブ: 共通サンプルで `toFilled` 系の描画を通し、チップと往復用の印を持たせる。保存時に
//     `toTemplate` で Jinja の原文へ戻る。
//   - 編集タブ: 値ファイル(`json/<ID>.json`)の値で `renderPlainFilled` を通し、印もチップも無い地の
//     HTML にする。編集タブの本文は値入りの地の文書なので、挿入した部分だけ Jinja が残ると申請で
//     止まり、ハイライトも漏れる。
// 値が無い・描けない書き方があっても挿入は止めず、空欄で入れて警告を返す。止めるのは編集タブで
// Jinja として読めないときだけ(地の本文へ生の Jinja を入れないため)。

import { renderPlainFilled, type SampleData } from '@editor/shared';
import { toFilledWithDiagnostics } from '@/lib/fillJinja';

/** 挿入する経路と、その経路の描画に使う値。 */
export type PartRenderContext =
  | { route: 'create'; sample: SampleData }
  | { route: 'edit'; values: SampleData; valuesFound: boolean };

const VALUES_NOT_FOUND =
  'このテンプレートの値ファイル（json）が見つからないため、値を空欄で挿入しました';

function unsupportedWarning(exprs: readonly string[]): string[] {
  return exprs.length > 0
    ? [`次の書き方は描画できないため空欄で挿入しました: ${exprs.join('、')}`]
    : [];
}

/**
 * パーツの `content` を経路 `ctx` の値で描く。警告は利用者へそのまま見せる文。編集タブで値ファイルが
 * 無いときは、欠けた値の一覧は全部になるだけなので出さず、値ファイルが無いことだけを知らせる。
 */
export function renderPartForInsert(
  content: string,
  ctx: PartRenderContext,
): { ok: true; html: string; warnings: string[] } | { ok: false; error: string } {
  if (ctx.route === 'create') {
    // 壊れた Jinja でも例外にせず断片全体を固めて返す(`toFilledWithDiagnostics` の自己検査)ので、
    // 作成タブは止めずに入れる。欠けた値は共通サンプルの登録漏れで、挿入のたびには知らせない。
    const { html, diagnostics } = toFilledWithDiagnostics(content, ctx.sample);
    return { ok: true, html, warnings: unsupportedWarning(diagnostics.unsupported) };
  }
  let rendered: ReturnType<typeof renderPlainFilled>;
  try {
    rendered = renderPlainFilled(content, ctx.values);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `パーツの Jinja を読めないため挿入できません: ${message}` };
  }
  const { missing, unsupported } = rendered.diagnostics;
  const warnings: string[] = [];
  if (!ctx.valuesFound) warnings.push(VALUES_NOT_FOUND);
  else if (missing.length > 0)
    warnings.push(`次の値が見つからないため空欄で挿入しました: ${missing.join('、')}`);
  warnings.push(...unsupportedWarning(unsupported));
  return { ok: true, html: rendered.html, warnings };
}
