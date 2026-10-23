// =============================================================================
// editingMarkerGate.ts — 申請・確定の本文に往復用の印が残っていたら拒否する関所
// =============================================================================
// 作成経路の本文は `toTemplate` が Jinja へ戻した原文、編集経路の本文は値入り HTML で、
// どちらにも往復用の印(範囲のコメント・チップ・clone)は 1 つも残らないはずである。残って
// いれば復元の欠陥か改変で、そのまま確定するとテンプレートや値入り HTML に印が焼き付く。
import { editingMarkerMessage, findEditingMarkers, validation } from '@editor/shared';

export function assertNoEditingMarkers(html: string, templateId: string): void {
  const msg = editingMarkerMessage(findEditingMarkers(html), templateId);
  if (msg !== null) throw validation(msg);
}
