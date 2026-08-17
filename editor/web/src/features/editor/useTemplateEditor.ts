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
  type PairSyncStatus,
  type PartCatalogItem,
  type PartHistoryEntry,
  type Template,
} from '@editor/shared';
import { computed, onBeforeUnmount, onMounted, ref, type ShallowRef, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useNoteRepo } from '@/api/repositories';
import { confirm } from '@/components/ui/confirm';
import { toast, toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';
import { useEditorSessionStore } from '@/stores/editorSession';
import { DEFAULT_GEOM, geomChangeLabel, geomFromStyle, geomToStyle, type LayoutGeom } from './geom';
import { partLabelMap, partPathKeyFor } from './partKey';
import { useTemplateEditorService } from './services/templateEditorService';
import { useAutosave } from './useAutosave';
import { useGrapes } from './useGrapes';
import { usePartEditHistory } from './usePartEditHistory';
import { usePartNote } from './usePartNote';
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
  const router = useRouter();
  const route = useRoute();
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
  /** 当該版インスタンス(templateId)の全パーツ履歴(永続層)。onMounted で一度ロードする。 */
  const allPartHistory = ref<PartHistoryEntry[]>([]);
  /**
   * 現在の選択パーツの永続履歴。版インスタンス全件から安定構造キー(`currentNoteKey`)で絞る。
   * GrapesJS の選択/改訂で再評価させるため reactive 値を読む。
   */
  const partHistory = computed<PartHistoryEntry[]>(() => {
    void g.selected.value;
    void g.revision.value;
    const key = currentNoteKey();
    return key ? allPartHistory.value.filter((e) => e.partKey === key) : [];
  });
  /**
   * 交付版⇄全体版 ペア同期の現況。未解決競合(自動同期停止中のパーツ)があるときだけ
   * canvas 上部にバナーを出す。取得失敗は無視する(バナーは補助情報で、編集を止めない)。
   */
  const syncStatus = ref<PairSyncStatus | null>(null);

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
  // 加えて変更のたびに debounce で localStorage へ永続ミラーし、リロード後も復元する。
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistUndo(): void {
    sessionStore.persist(id);
  }
  function debouncedPersistUndo(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistUndo();
    }, 500);
  }
  const {
    canUndo,
    canRedo,
    pushUndo,
    undo,
    redo,
    discardLast,
    depth: undoDepth,
  } = useSnapshotHistory(
    () => ({ html: g.getBodyHtml(), css: g.getCss() }),
    (s) => {
      // snapshot は localStorage ミラー由来でもありうる。CSS 拒否で canvas が入れ替わって
      // いないのに autosave すると、汚染 snapshot 側の内容で draft を壊す。
      if (!g.load(s.html, s.css)) return;
      // load() は既定フラグで component を再構築する — lock state を再適用する。
      g.setEditable(allowEdit.value);
      autosave.trigger();
    },
    100,
    { past: sess.undoPast, future: sess.undoFuture, onChange: debouncedPersistUndo },
  );

  const { record: recordChange, displayHistory } = usePartEditHistory(
    id,
    // 版を跨いで安定な構造キーで紐づける(メモと共用)。GrapesJS の component id は
    // リロード/版再生成で再採番され、永続履歴が孤児化するため使わない。選択/編集で
    // displayHistory を再評価させるため reactive 値を読む(computed の依存に含める)。
    () => {
      void g.selected.value;
      void g.revision.value;
      return currentNoteKey() ?? undefined;
    },
    () => auth.user?.displayName ?? '編集者',
    // 永続 history の getter。選択中はそのパーツに絞り、未選択(全パーツ表示)では全件を返す。
    (key) => (key ? allPartHistory.value.filter((e) => e.partKey === key) : allPartHistory.value),
    // 各編集を永続化する(fire-and-forget)。失敗は log するが表に出さない。
    // セッション内エントリは既に表示済みで、autosave 済み draft が内容を保持するため。
    (partKey, change) => {
      service.recordPartChange(id, partKey, change).then((res) => {
        if (isErr(res)) logError(res.error);
      });
    },
    // セッション内修正履歴もストア管理にし、プレビュー往復で右下の履歴を維持する。
    { history: sess.partHistory, nextSeq: () => ++sess.seq },
  );

  // ── パーツ単位メモ(版インスタンス単位) ──
  // メモは templateId(委託会社/ファンドコード/基準日/版種を内包)単位で、版内で安定な構造
  // キー(`partKey.ts`)で保持する。別の基準日/版種の版へは引き継がない。編集は即時ローカル
  // 反映 + debounce 永続化。
  const noteRepo = useNoteRepo();

  /** canvas のルート要素(GrapesJS wrapper、無ければ body)。パーツ列挙/キー解決の基準。 */
  function canvasRoot(): HTMLElement | undefined {
    const ed = g.editor.value;
    return (ed?.getWrapper()?.getEl?.() ?? ed?.Canvas?.getBody?.()) as HTMLElement | undefined;
  }

  /** 現在の canvas 選択を、版を跨いで安定なパーツ構造キーへ解決する(無ければ null)。 */
  function currentNoteKey(): string | null {
    const ed = g.editor.value;
    const el = ed?.getSelected()?.getEl?.() as HTMLElement | undefined;
    const root = canvasRoot();
    if (!el || !root) return null;
    return partPathKeyFor(el, root);
  }

  /**
   * canvas 全パーツの安定キー → 表示ラベル(`ページN・パーツM`)。全パーツ横断の修正履歴で
   * 各行がどのパーツの変更かを示すのに使う。canvas 構築/編集で再評価させるため reactive 値を読む。
   */
  const partLabels = computed<Map<string, string>>(() => {
    void g.revision.value;
    const root = canvasRoot();
    return root ? partLabelMap(root) : new Map();
  });

  const note = usePartNote(
    () => template.value?.meta.id ?? '',
    () => {
      // 選択/編集で再評価させるため reactive 値を読む(computed の依存に含める)。
      void g.selected.value;
      void g.revision.value;
      return currentNoteKey();
    },
    () => auth.user?.displayName ?? '編集者',
    noteRepo,
  );

  // メモを持つパーツ集合が変わるたび、canvas のセル風マーカーを更新する。
  watch(note.notedKeys, (keys) => g.setNoteKeys(keys), { immediate: true });

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

  /**
   * 破壊的だが Undo 可能な操作(削除/配置初期化)の実行直後フィードバック。確認ダイアログは
   * 挟まない — 変更はドラフト上の操作で、本番反映は確定保存申請→承認フローが担うため。
   * かわりに「元に戻す」付きトーストを出す。押下時点で別の編集が積まれていたら、その編集
   * ごと巻き戻す事故を避けるため undo せず Ctrl+Z の案内に切り替える。
   */
  function toastUndoable(message: string): void {
    const depthAtOp = undoDepth();
    toast(message, {
      durationMs: 6000,
      action: {
        label: '元に戻す',
        onClick: () => {
          if (undoDepth() !== depthAtOp) {
            toast('その後の編集があるため、Ctrl+Z で順に戻してください');
            return;
          }
          undo();
        },
      },
    });
  }

  /** 選択の layout style を全消去する(既定配置へ戻す)。 */
  function resetGeom() {
    if (!g.selected.value) return;
    pushUndo();
    g.patchSelectedStyle(geomToStyle(DEFAULT_GEOM));
    recordChange('配置を初期化');
    toastUndoable('配置を初期化しました');
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
    const sel = g.selected.value;
    if (!sel) return;
    // パーツ名と修正履歴の記録は、削除後に選択が消えてキー解決できなくなるため削除前に行う。
    // 履歴へ残すことで、確定保存申請の精査時に承認者が編集者の削除操作を追える。
    const name = canvasPart.value?.name ?? sel.name;
    recordChange(`パーツ「${name}」を削除`);
    pushUndo();
    g.deleteSelected();
    toastUndoable(`パーツ「${name}」を削除しました`);
  }

  // 「編集を許可」チェックボックスの切替で canvas を lock/unlock する。
  watch(allowEdit, (on) => g.setEditable(on));

  // 選択変更で catalog part を解決する。永続履歴は `allPartHistory`(版インスタンス全件)を
  // onMounted で一度ロードし、表示は `partHistory` computed が選択キーで in-memory に絞るため、
  // 選択ごとの非同期 fetch も race 対策も不要になった。
  watch(
    () => g.selected.value,
    (sel) => {
      canvasPart.value = sel?.partId ? (partsById.get(sel.partId) ?? null) : null;
    },
  );

  onMounted(async () => {
    const res = await service.loadForEdit(id);
    if (isErr(res)) {
      logError(res.error);
      toastError(res.error.message);
      // 不正/存在しない id では空のエディタ枠を残さず一覧へ戻す(`/preview` 側の
      // 「見つかりません」表示と挙動を揃える)。
      router.replace({ name: 'edit' });
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
    // service の入口ガードを通っていれば false にはならないが、拒否された場合は空の
    // エディタ枠を残さず一覧へ戻す(不正 id と同じ後始末)。トーストは load が出している。
    if (!g.load(res.value.editableBody, res.value.css)) {
      router.replace({ name: 'edit' });
      return;
    }
    // 差し込み値ハイライトは作成経路(`?created=1`)でのみ出す。編集経路(query なし)は実値編集
    // なので出さない。設計正典.md「編集 2 系統」を参照。
    g.setVarsHighlight(route.query.created === '1');
    // locked 状態で開始する(allowEdit の既定は false)。
    g.setEditable(allowEdit.value);
    // 当該版インスタンスのメモを読み込む(マーカー/メモ欄へ反映)。load 後のレイアウト確定で
    // `refreshPageGuides`→`refreshNoteMarkers` が位置を測り直す。
    void note.reload();
    // 当該版インスタンスの全パーツ履歴を一度だけロードする。表示は `partHistory` computed が
    // 選択キーで絞る(リロード後も安定構造キーで一致するため右下の履歴が復元される)。
    void service.listPartHistory(id).then((res) => {
      if (isOk(res)) allPartHistory.value = res.value;
      else logError(res.error);
    });
    // ペア同期の競合バナー用。編集経路のみ(作成経路 `?created=1` は未確定テンプレでペア無し)。
    if (route.query.created !== '1') {
      void service.getSyncStatus(id).then((res) => {
        if (isOk(res)) syncStatus.value = res.value;
      });
    }
    // canvas の全変更はここを通る — dirty を立て、autosave を起動する。`g.onChange` は
    // load() より後に張るため、初期ロードでは発火せず純粋なユーザー編集だけを拾う。
    g.onChange(() => {
      dirty.value = true;
      autosave.trigger();
    });
    // ロック中(編集不許可)にダブルクリック(編集ジェスチャ)をした場合、解除導線を案内する。
    // 既定ロック開始のため「編集を許可」トグルに気付かないと何も編集できない — その発見性を補う。
    // 騒音にならないようセッション中 1 回だけ出す。
    let lockGuideShown = false;
    g.onCanvasDblClick(() => {
      if (allowEdit.value || lockGuideShown) return;
      lockGuideShown = true;
      toast('編集はロックされています。上部バーまたは左パネルの「編集を許可」をオンにしてください');
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

  // autosave の失敗はステータス行だけでは見逃しうる(狭幅ではアイコンのみになる)ため、
  // error への遷移エッジで 1 回だけトーストする。debounce された失敗のたびに重ねない方針は
  // `useAutosave.ts` のコメントを見よ。
  watch(autosave.state, (s, prev) => {
    if (s === 'error' && prev !== 'error') {
      toastError('自動保存に失敗しました。「再試行」で保存し直してください');
    }
  });

  // 未保存分が失われうる間は、離脱(tab を閉じる / reload)前に警告する。debounce 待機中
  // (`pending`)は state が idle/saved のままでも直近の編集が未保存なので含める。dirty 単独では
  // 警告しない — draft は autosave 済みで、次回オープン時に復元されるため。
  function beforeUnload(e: BeforeUnloadEvent) {
    const st = autosave.state.value;
    if (autosave.pending.value || st === 'saving' || st === 'error') {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', beforeUnload);

  // タブ切替/最小化の時点で debounce を待たず保存を確定し、「未保存の窓」自体を短くする。
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden' && autosave.pending.value) void autosave.flush();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    void note.flush(); // 保留中のメモ保存を取りこぼさない(プレビュー往復の再マウント含む)
    // 保留中の Undo 永続ミラーを確定する(プレビュー往復の再マウント/リロード前)。
    if (persistTimer) clearTimeout(persistTimer);
    persistUndo();
    g.destroy();
  });

  // アプリ内 navigation guard。
  //  - プレビュー / 承認精査(バッジ経由)への遷移(編集セッション内)は破棄しない:
  //    履歴・Undo/Redo・draft を維持する。
  //  - メニュー等へ離脱する際は、確定保存していない変更があれば yes/no で確認し、承諾された
  //    場合は draft とセッション履歴を破棄してから移動する(キャンセルなら離脱中止)。
  onBeforeRouteLeave(async (to) => {
    if (autosave.state.value === 'saving') await autosave.flush();
    await note.flush(); // メモの保留分を確定してから離脱する(メモは破棄対象外で常に保持)

    // 同一テンプレートのプレビューへの往復はセッションを保持する。
    if (to.name === 'preview' && to.params.id === id) return true;
    // 上部バーの「承認待ち」バッジ経由の精査画面往復も同じ扱い(`fromEdit` は `EditorView` の
    // `goReview` だけが付ける往復マーカー)。状況確認のたびに編集を破棄させない。
    // 通常のタブ遷移・直 URL はマーカーが無いので従来どおり下の破棄確認に当たる。
    if (to.name === 'review-detail' && to.query.fromEdit === id) return true;

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
    syncStatus,
    partHistory,
    displayHistory,
    partLabels,
    selectedPart,
    selectedGeom,
    noteText: note.currentNote,
    canNote: note.canNote,
    setNote: note.setCurrent,
    allowAdd,
    allowEdit,
    dirty,
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
