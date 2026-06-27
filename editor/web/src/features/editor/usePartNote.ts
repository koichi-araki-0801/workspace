// =============================================================================
// usePartNote.ts — パーツ単位メモ(版インスタンス単位)の読込/編集/永続化 composable
// =============================================================================
// 役割: 現在の版インスタンスの全メモを保持し、選択中パーツ(版内で安定な構造パスキー)の
// メモ本文を提示・更新する。編集はローカルへ即時反映してマーカー/表示へ反映し、永続化は
// debounce する(`useAutosave` と同思想)。記録/解決ロジックを `useTemplateEditor.ts` から
// 分離し、`usePartEditHistory.ts` と同様に getter 注入で単体テスト可能に保つ。

import { isErr, type NoteRepository, type PartNote } from '@editor/shared';
import { computed, reactive } from 'vue';
import { logError } from '@/lib/appError';

/**
 * パーツ単位メモ(版インスタンス単位)。`templateId` 配下の全メモを `pathKey` で引けるよう
 * 保持し、選択中パーツのメモを読み書きする。`templateId`/`currentKey`/`userName` は getter で
 * 受け、選択やテンプレ読込に追従する(`currentKey` の getter 内で reactive 値を読めば computed
 * が追従)。別の基準日/版種の版へは引き継がない(templateId が変われば別メモ)。
 *
 * @param templateId  現在の版インスタンス id の getter(空なら no-op)
 * @param currentKey  選択中パーツの構造キーの getter(解決不能なら null)
 * @param userName    操作ユーザーの表示名の getter
 * @param repo        メモの永続化先(`NoteRepository`)
 * @param debounceMs  永続化の debounce(既定 600ms)
 */
export function usePartNote(
  templateId: () => string,
  currentKey: () => string | null,
  userName: () => string,
  repo: NoteRepository,
  debounceMs = 600,
) {
  // templateId 配下の全メモ(pathKey → PartNote)。`reload` で満たし、編集で即時反映する。
  const notes = reactive<Record<string, PartNote>>({});

  /** メモ本文を持つ pathKey 集合(canvas のマーカー描画を駆動する)。 */
  const notedKeys = computed<Set<string>>(() => {
    const s = new Set<string>();
    for (const [k, n] of Object.entries(notes)) if (n.content.trim() !== '') s.add(k);
    return s;
  });

  /** 現在の選択パーツのメモ本文(無ければ空文字)。 */
  const currentNote = computed<string>(() => {
    const k = currentKey();
    return k ? (notes[k]?.content ?? '') : '';
  });

  /** 現在の選択がメモ対象キーへ解決できるか(UI の有効/無効判定)。 */
  const canNote = computed<boolean>(() => currentKey() !== null);

  /** 現在の版インスタンスの全メモを読み込み直す(テンプレ読込時に呼ぶ)。 */
  async function reload(): Promise<void> {
    for (const k of Object.keys(notes)) delete notes[k];
    const tid = templateId();
    if (!tid) return;
    const res = await repo.listNotes(tid);
    if (isErr(res)) {
      logError(res.error);
      return;
    }
    for (const n of res.value) notes[n.pathKey] = n;
  }

  // debounce 永続化。編集時点の (templateId, key) を capture して保存するため、保存待ちの間に
  // 選択が変わってもメモを取り違えない。空文字は repo 側で削除に倒れる。
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { templateId: string; key: string; content: string } | null = null;

  /** 保留中の保存を即座に確定する(離脱/アンマウント前に呼ぶ)。 */
  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const { templateId: tid, key, content } = pending;
    pending = null;
    const res = await repo.saveNote(tid, key, content);
    if (isErr(res)) logError(res.error);
  }

  /** 現在の選択パーツのメモを更新する(ローカル即時反映 + debounce 永続化)。 */
  function setCurrent(content: string): void {
    const key = currentKey();
    const tid = templateId();
    if (!key || !tid) return;
    if (content.trim() === '') {
      delete notes[key];
    } else {
      notes[key] = {
        templateId: tid,
        pathKey: key,
        content,
        updatedAt: new Date().toISOString(),
        updatedBy: userName(),
      };
    }
    pending = { templateId: tid, key, content };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  return { notes, notedKeys, currentNote, canNote, reload, setCurrent, flush };
}
