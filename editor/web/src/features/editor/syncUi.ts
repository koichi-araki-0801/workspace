// =============================================================================
// syncUi.ts — 編集画面の UI 状態をセッションへ写して永続する
// =============================================================================

import { type Ref, watch } from 'vue';
import type { EditorUiState, useEditorSessionStore } from '@/stores/editorSession';

/**
 * `source` の変化を当該テンプレートの `ui[key]` へ写し、そのたびに `persistUi` で永続する
 * (倍率・表示系。`allowEdit` / `selectedKey` は永続しないので対象にしない)。コンポーネントの
 * `setup` から呼ぶ。
 */
export function syncUi<K extends keyof EditorUiState>(
  store: ReturnType<typeof useEditorSessionStore>,
  templateId: string,
  source: Ref<EditorUiState[K]>,
  key: K,
): void {
  watch(source, (v) => {
    store.sessions[templateId].ui[key] = v;
    store.persistUi(templateId);
  });
}
