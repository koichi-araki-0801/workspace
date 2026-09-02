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
import { toast, toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';
import { useEditorSessionStore } from '@/stores/editorSession';
import { DEFAULT_GEOM, geomChangeLabel, geomFromStyle, geomToStyle, type LayoutGeom } from './geom';
import { partLabelMap, partPathKeyFor } from './partKey';
import { useRedline } from './redline/useRedline';
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

  // 確定版からの変更箇所の赤入れ(旧文言の取り消し線)。基準は load 後に `setBaseline` で入れる。
  const redline = useRedline({
    editor: g.editor,
    revision: g.revision,
    editing: g.editing,
    dirty,
    parseHtml: g.parseHtmlQuiet,
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
    beginUndo,
    commitUndo,
    cancelUndo,
    undo,
    redo,
    depth: undoDepth,
    syncFlags: syncUndoFlags,
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

  // ── パーツ単位メモ(追記型スレッド) ──
  // メモは追記型スレッドで、投稿は書かれた版インスタンスのファイルへ入る。表示は交付版⇄
  // 全体版のペアをマージした 1 本のスレッド(基準日をまたぐ繰り越しはしない)。パーツの
  // 同定は版内で安定な構造キー(`partKey.ts`)で行う。
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
    noteRepo,
  );

  // メモを持つパーツ集合が変わるたび、canvas のセル風マーカーを更新する。
  watch(note.notedKeys, (keys) => g.setNoteKeys(keys), { immediate: true });

  /**
   * 選択ブロックへ幾何変更を適用する(inline style として書き込む)。値が動かない適用は
   * 手前で捨てる — `pushUndo` は future を消すため、無変更でも積むと Redo が失われる。
   */
  function applyGeom(patch: Partial<LayoutGeom>, record = true) {
    const cur = selectedGeom.value;
    if (!cur) return;
    const after = { ...cur, ...patch };
    const label = geomChangeLabel(cur, after);
    if (!label) return;
    if (record) pushUndo();
    g.patchSelectedStyle(geomToStyle(after));
    if (record) recordChange(label);
  }

  /**
   * ハンドル drag 1 ジェスチャ分の後始末。幾何が動いていれば `beginUndo` の保留 snapshot を
   * 確定して history へ 1 件記録し、動いていなければ保留を捨てる(Redo を残す)。
   */
  function recordGeomDiff(before: LayoutGeom) {
    const after = selectedGeom.value;
    const label = after ? geomChangeLabel(before, after) : null;
    if (!label) {
      cancelUndo();
      return;
    }
    commitUndo();
    recordChange(label);
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
    // 別タブの下書きを破棄して確定版から開いたときは、ミラーから復元した Undo も捨てる。
    // 残すと Undo 1 回で破棄したはずの本文が戻り、autosave で下書きとして書き戻る。
    if (res.value.discardedStaleDraft) {
      sessionStore.reset(id);
      syncUndoFlags(); // 空にした配列へボタンの活性を追随させる
    }
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
    // 赤入れの基準は確定版の値埋め込み本文(`loadForEdit` が `filled` または `toFilled` で
    // 解決する)。REST の `getTemplate` は `filled` を常に空で返すため、`template.filled` を
    // 直に読むと本番では基準が無く機能が黙って死ぬ。作成経路(`?created=1`)は確定版そのものが
    // 無いので機能を出さない。
    redline.setBaseline(route.query.created === '1' ? undefined : res.value.confirmedBody);
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
    // inline text 編集: 開始で snapshot を保留し、内容が変わった場合だけ undo へ確定する
    g.onTextEditStart(() => beginUndo());
    g.onTextEditEnd((changed) => {
      redline.schedule();
      if (changed) {
        commitUndo();
        recordChange('テキストを編集');
      } else {
        cancelUndo();
      }
    });
    // canvas の drag-to-reorder: 開始で snapshot を保留し、順序が変わった時だけ確定する
    g.onReorderStart(() => {
      beginUndo();
      redline.onDragStart();
    });
    g.onReorderEnd((moved) => {
      redline.onDragEnd();
      if (moved) {
        commitUndo();
        recordChange('順序を変更');
      } else {
        cancelUndo();
      }
    });
    // 選択のたびに選択パーツの装飾を外す。RTE が開始時に読む `innerHTML` に旧文言を残さない
    // ため、Vue の flush を待たず同期で処理する(click は dblclick に先行する)。
    watch(g.selected, () => redline.onSelected(g.editor.value?.getSelected()), { flush: 'sync' });
  });

  // autosave の失敗はステータス行だけでは見逃しうる(狭幅ではアイコンのみになる)ため、
  // error への遷移エッジで 1 回だけトーストする。debounce された失敗のたびに重ねない方針は
  // `useAutosave.ts` のコメントを見よ。
  watch(autosave.state, (s, prev) => {
    if (s === 'error' && prev !== 'error') {
      toastError('自動保存に失敗しました。「再試行」で保存し直してください');
    }
  });

  // 閉じる / reload の前に警告する条件は「未確定の編集がある」(`dirty`)、または autosave が
  // 未保存の窓にある(debounce 待ち・保存中・失敗)。編集セッションはブラウザタブの寿命で、
  // 閉じると次回オープン時に draft が破棄されるため、autosave 済みでも dirty なら警告する。
  // reload は同じセッションなので実際には残るが、ブラウザは閉じると reload を区別しない。
  function beforeUnload(e: BeforeUnloadEvent) {
    const st = autosave.state.value;
    if (dirty.value || autosave.pending.value || st === 'saving' || st === 'error') {
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
    // 保留中の Undo 永続ミラーを確定する(プレビュー往復の再マウント/リロード前)。
    if (persistTimer) clearTimeout(persistTimer);
    persistUndo();
    g.destroy();
  });

  // アプリ内 navigation guard。編集セッションはブラウザタブの寿命なので、タブ遷移・
  // プレビュー往復・精査画面往復のどれでも破棄しない(draft は autosave 済み、履歴と
  // Undo/Redo は `editorSession` ストアが templateId 単位で保持する)。進行中の保存だけは
  // 待ってから離れる — 離脱直後に着地した保存が、次の画面で読んだ内容より古い draft を
  // 書き戻さないため。閉じたタブが残した draft の破棄は `loadForEdit` が次回オープン時に行う。
  onBeforeRouteLeave(async () => {
    await autosave.settled();
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
    noteEntries: note.entries,
    canNote: note.canNote,
    addNote: note.add,
    updateNote: note.update,
    removeNote: note.remove,
    allowAdd,
    allowEdit,
    dirty,
    autosave,
    canUndo,
    canRedo,
    undo,
    redo,
    beginUndo,
    applyGeom,
    recordGeomDiff,
    resetGeom,
    moveSelected,
    deletePart,
    onPartSelect,
    onPartInsert,
    redlineEnabled: redline.enabled,
    redlineAvailable: redline.available,
    toggleRedline: redline.toggle,
  };
}
