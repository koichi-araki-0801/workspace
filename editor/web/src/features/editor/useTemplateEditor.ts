// =============================================================================
// useTemplateEditor.ts — editor 画面のオーケストレーション composable
// =============================================================================
// 役割: template 読込・GrapesJS + autosave のライフサイクル・canvas 選択から
// catalog docs への解決・保存中/失敗中の navigation guard をまとめ、
// `EditorView.vue` を presentational に保つ。
import {
  isErr,
  isOk,
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type Template,
} from '@editor/shared';
import { computed, onBeforeUnmount, onMounted, ref, type ShallowRef, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { confirm } from '@/components/ui/confirm';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';
import { useEditorSessionStore } from '@/stores/editorSession';
import { DEFAULT_GEOM, geomChangeLabel, geomFromStyle, geomToStyle, type LayoutGeom } from './geom';
import { useTemplateEditorService } from './services/templateEditorService';
import { useAutosave } from './useAutosave';
import { useGrapes } from './useGrapes';
import { usePartEditHistory } from './usePartEditHistory';
import { useSnapshotHistory } from './useSnapshotHistory';

/**
 * editor 画面のオーケストレーション: template を読み込み、GrapesJS + autosave の
 * ライフサイクルを駆動し、canvas 選択を catalog docs へ解決し、保存が pending/失敗中の
 * 間は navigation を guard する。`EditorView.vue` を presentational に保つ。
 * GrapesJS/Jinja の内部は `useGrapes.ts` / jinjaMask に留める。
 */
export function useTemplateEditor(
  id: string,
  els: {
    canvasEl: Readonly<ShallowRef<HTMLElement | null>>;
    layersEl: Readonly<ShallowRef<HTMLElement | null>>;
  },
) {
  const { canvasEl, layersEl } = els;
  const service = useTemplateEditorService();
  const auth = useAuthStore();
  const sessionStore = useEditorSessionStore();
  const g = useGrapes();

  // 編集セッション(履歴 + Undo/Redo)。プレビュー往復で EditorView が再マウントされても
  // ストア側に生存し、ここで `ensure` すると同一セッションが返って履歴が継続する。
  const sess = sessionStore.ensure(id);

  // 未確定の変更があるか。確定保存せずメニューへ戻る際の破棄判定に使う。canvas 編集で
  // 立ち、初期値は前回セッションの draft 有無(`loadForEdit` 結果)で決める。
  const dirty = ref(false);

  const template = ref<Template | null>(null);
  const fundName = ref('');
  const partHistory = ref<PartHistoryEntry[]>([]);
  /** catalog で最後にクリックされた part(挿入時のプレビュー)。 */
  const previewPart = ref<PartCatalogItem | null>(null);
  /** 現在の canvas 選択から解決した part(catalog part でなければ null)。 */
  const canvasPart = ref<PartCatalogItem | null>(null);
  /** canvas 選択を docs へ解決するため cache した catalog parts。 */
  const partsById = new Map<string, PartCatalogItem>();

  /** 左ペイン「パーツを追加」トグル: catalog を表示し挿入を許可する。 */
  const allowAdd = ref(false);
  /** 左ペイン「編集を許可」トグル: canvas を編集可(text/並べ替え/layout)にする。 */
  const allowEdit = ref(false);

  // プロパティペイン: canvas 選択があればそれ、無ければ catalog プレビュー。
  const selectedPart = computed(() => (g.selected.value ? canvasPart.value : previewPart.value));

  // 現在の canvas 選択の幾何(inline style から読む)。`g.revision` が style/component
  // 変更ごとにこれを再トリガする。
  const selectedGeom = computed(() => {
    void g.revision.value;
    return g.selected.value ? geomFromStyle(g.selectedStyle()) : null;
  });

  const autosave = useAutosave(async () => {
    if (!template.value) return ok(undefined);
    return service.saveDraft(id, g.getBodyHtml(), g.getCss());
  });

  // ── 1. undo / redo (snapshot 方式) ──
  // GrapesJS の UndoManager はプログラム経由の style 書き込みを確実には追えないため、
  // 自前で { html, css } snapshot の stack を持ち、load() で復元する。
  // Undo/Redo スタックはストアの配列を参照で共有する(プレビュー往復で維持する)。
  const { canUndo, canRedo, pushUndo, undo, redo, discardLast } = useSnapshotHistory(
    () => ({ html: g.getBodyHtml(), css: g.getCss() }),
    (s) => {
      g.load(s.html, s.css);
      // load() は既定フラグで component を再構築する — lock state を再適用する。
      g.setEditable(allowEdit.value);
      autosave.trigger();
    },
    100,
    { past: sess.undoPast, future: sess.undoFuture },
  );

  const { record: recordChange, displayHistory } = usePartEditHistory(
    id,
    () => g.selected.value?.id,
    () => auth.user?.displayName ?? '編集者',
    () => partHistory.value,
    // 各編集を永続化する(fire-and-forget)。失敗は log するが表に出さない。
    // セッション内エントリは既に表示済みで、autosave 済み draft が内容を保持するため。
    (partId, change) => {
      service.recordPartChange(id, partId, change).then((res) => {
        if (isErr(res)) logError(res.error);
      });
    },
    // セッション内修正履歴もストア管理にし、プレビュー往復で右下の履歴を維持する。
    { history: sess.partHistory, nextSeq: () => ++sess.seq },
  );

  /** 選択ブロックへ幾何変更を適用する(inline style として書き込む)。 */
  function applyGeom(patch: Partial<LayoutGeom>, record = true) {
    const cur = selectedGeom.value;
    if (!cur) return;
    if (record) pushUndo();
    const after = { ...cur, ...patch };
    g.patchSelectedStyle(geomToStyle(after));
    if (record) {
      const label = geomChangeLabel(cur, after);
      if (label) recordChange(label);
    }
  }

  /** 幾何 diff の history エントリを 1 件記録する(ハンドル drag 後に使う)。 */
  function recordGeomDiff(before: LayoutGeom) {
    const after = selectedGeom.value;
    if (!after) return;
    const label = geomChangeLabel(before, after);
    if (label) recordChange(label);
  }

  /** 選択の layout style を全消去する(既定配置へ戻す)。 */
  function resetGeom() {
    if (!g.selected.value) return;
    pushUndo();
    g.patchSelectedStyle(geomToStyle(DEFAULT_GEOM));
    recordChange('配置を初期化');
  }

  function onPartSelect(p: PartCatalogItem) {
    previewPart.value = p;
  }

  function onPartInsert(p: PartCatalogItem) {
    pushUndo();
    g.insertPart(p.content, p.id);
    // 挿入直後の part も現在の lock state に従わせる。
    g.setEditable(allowEdit.value);
    previewPart.value = p;
    recordChange(`パーツ「${p.name}」を追加`);
  }

  function moveSelected(dir: -1 | 1) {
    pushUndo();
    g.moveSelected(dir);
    recordChange(dir < 0 ? '順序を前へ移動' : '順序を後ろへ移動');
  }

  /** 現在の選択を削除する(history を考慮)。 */
  function deletePart() {
    if (!g.selected.value) return;
    pushUndo();
    g.deleteSelected();
  }

  // 「編集を許可」チェックボックスの切替で canvas を lock/unlock する。
  watch(allowEdit, (on) => g.setEditable(on));

  // 選択変更ごとに加算する。下の非同期 history fetch は、より新しい選択に追い越されたら
  // 結果を捨てる(遅い応答が別 part の history を上書きするのを防ぐ)。
  let historySeq = 0;
  watch(
    () => g.selected.value,
    async (sel) => {
      const seq = ++historySeq;
      // catalog part は同期的に解決し、history fetch を待たずプロパティペインを
      // 即座に更新する。
      canvasPart.value = sel?.partId ? (partsById.get(sel.partId) ?? null) : null;
      if (sel && !sel.isJinja) {
        const res = await service.getPartHistory(id, sel.id);
        if (seq !== historySeq) return; // より新しい選択が race に勝った
        partHistory.value = isOk(res) ? res.value : [];
      } else {
        partHistory.value = [];
      }
    },
  );

  onMounted(async () => {
    const res = await service.loadForEdit(id);
    if (isErr(res)) {
      logError(res.error);
      toastError(res.error.message);
      return;
    }
    template.value = res.value.template;
    fundName.value = res.value.fundName;
    // 前回セッションの未確定 draft が残っていれば、最初から dirty 扱いにする。
    dirty.value = res.value.hasDraft;
    for (const p of res.value.parts) partsById.set(p.id, p);

    const canvas = canvasEl.value;
    const layers = layersEl.value;
    if (!canvas || !layers) return;
    g.init({ canvas, layers });
    g.load(res.value.editableBody, res.value.css);
    // locked 状態で開始する(allowEdit の既定は false)。
    g.setEditable(allowEdit.value);
    // canvas の全変更はここを通る — dirty を立て、autosave を起動する。`g.onChange` は
    // load() より後に張るため、初期ロードでは発火せず純粋なユーザー編集だけを拾う。
    g.onChange(() => {
      dirty.value = true;
      autosave.trigger();
    });
    // inline text 編集: 開始で snapshot、終了時は内容が変わった場合だけ残す
    g.onTextEditStart(() => pushUndo());
    g.onTextEditEnd((changed) => {
      if (changed) {
        recordChange('テキストを編集');
      } else {
        discardLast();
      }
    });
    // canvas の drag-to-reorder: 開始で snapshot、順序が変わった時だけ記録する
    g.onReorderStart(() => pushUndo());
    g.onReorderEnd((moved) => {
      if (moved) {
        recordChange('順序を変更');
      } else {
        discardLast();
      }
    });
  });

  // 保存が進行中/失敗中の間は、離脱(tab を閉じる / reload)前に警告する。
  function beforeUnload(e: BeforeUnloadEvent) {
    if (autosave.state.value === 'saving' || autosave.state.value === 'error') {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', beforeUnload);

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    g.destroy();
  });

  // アプリ内 navigation guard。
  //  - プレビューへの遷移(編集セッション内)は破棄しない: 履歴・Undo/Redo・draft を維持する。
  //  - メニュー等へ離脱する際は、確定保存していない変更があれば yes/no で確認し、承諾された
  //    場合は draft とセッション履歴を破棄してから移動する(キャンセルなら離脱中止)。
  onBeforeRouteLeave(async (to) => {
    if (autosave.state.value === 'saving') await autosave.flush();

    // 同一テンプレートのプレビューへの往復はセッションを保持する。
    if (to.name === 'preview' && to.params.id === id) return true;

    if (dirty.value) {
      const discard = await confirm({
        title: '保存していない変更があります',
        description: '確定保存していない編集内容は破棄されます。よろしいですか？',
        confirmLabel: '破棄して戻る',
        cancelLabel: '編集に戻る',
        variant: 'destructive',
      });
      if (!discard) return false; // 離脱中止: 編集画面に留まる
      const res = await service.discardDraft(id);
      if (isErr(res)) logError(res.error); // 破棄失敗は log のみ(移動は止めない)
    }
    // 破棄を確定、または変更なし: セッション履歴/Undo/Redo を後始末して移動する。
    sessionStore.clear(id);
    return true;
  });

  return {
    g,
    template,
    fundName,
    partHistory,
    displayHistory,
    selectedPart,
    selectedGeom,
    allowAdd,
    allowEdit,
    autosave,
    canUndo,
    canRedo,
    undo,
    redo,
    pushUndo,
    applyGeom,
    recordGeomDiff,
    resetGeom,
    moveSelected,
    deletePart,
    onPartSelect,
    onPartInsert,
  };
}
