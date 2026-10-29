// =============================================================================
// useEditorChangeView.ts — 編集画面の変更の見え方(番号・パーツの名前・修正履歴の見出し・却下の理由)
// =============================================================================
// 役割: canvas の全パーツ(`partEntries` の 1 回の数え上げ)から、ラベル(`ページN・パーツM`)と
// 表示名を作り、変更の番号(`useChangeNumbers.ts`)・前回の申請の却下の理由
// (`useRejectedReasons.ts`)と合わせて、右ペイン「プロパティ」(`Inspector.vue`)と紙面の目印
// (`useCanvasMarkers.ts`)へ渡す値を組む。GrapesJS には依存しない(canvas の読み出しは呼び手が
// 渡す)ので、配線を単体テストで確かめられる(`web/test/useEditorChangeView.dom.test.ts`)。
// オーケストレーションは `useTemplateEditor.ts`。

import {
  type PartCatalogItem,
  type PartHistoryEntry,
  partDisplayName,
  partNameOfElement,
  type ReviewRepository,
} from '@editor/shared';
import { computed, type Ref, ref, watch } from 'vue';
import { submitBodyOf } from '@/features/preview/services/submitBody';
import { partNameOf } from '@/lib/partNames';
import { groupHistoryByPart } from './historyGroups';
import { type PartEntry, partLabelOf } from './partKey';
import { changeBaselineOf, createChangeCheckScheduler, useChangeNumbers } from './useChangeNumbers';
import { useRejectedReasons } from './useRejectedReasons';

export function useEditorChangeView(ctx: {
  /** canvas の全パーツ(紙面の順)。canvas の構築・編集・ページの数え直しで読み直される値。 */
  canvasEntries: Readonly<Ref<readonly PartEntry[]>>;
  /** カタログのパーツ(id → パーツ)。読み込みで差し替わる(業務名の元)。 */
  partsById: Readonly<Ref<ReadonlyMap<string, PartCatalogItem>>>;
  /** 選択中のパーツのキー(無ければ null)。 */
  selectedKey: Readonly<Ref<string | null>>;
  /** 修正履歴(選択中はそのパーツ、未選択は全パーツ)。 */
  history: Readonly<Ref<readonly PartHistoryEntry[]>>;
  /** canvas の本文(`getBodyHtml()`)。 */
  readBody: () => string;
  /**
   * 変更の通知の待ちのあとに読んだ本文(番号を出さない経路でも呼ぶ)。確定版との同一判定が同じ本文を
   * 使い、直列化を 1 回にする(`createChangeCheckScheduler` の `onRead`)。
   */
  onBodyRead?: (body: string) => void;
  /** `onBodyRead` が本文を要るか(要らない間は、番号を出さない経路で本文を読まない)。 */
  wantsBodyRead?: () => boolean;
  /** 番号の変化を紙面の目印へ流す(`useCanvasMarkers.ts` の `setChangeNumbers`)。 */
  setChangeNumbers: (byKey: Map<string, number>) => void;
  /** 前回の申請の却下の理由を引くための材料(`useRejectedReasons.ts`)。 */
  templateId: string;
  me: () => string | null;
  reviews: ReviewRepository;
}) {
  /** カタログの id → 業務名。`partsById` が差し替わると作り直す(読み込みの順に依らない)。 */
  const nameById = computed(
    () => new Map([...ctx.partsById.value.values()].map((p) => [p.id, p.name])),
  );

  /**
   * canvas 全パーツの安定キー → 表示ラベル(`ページN・パーツM`)。全パーツ横断の修正履歴で各行が
   * どのパーツの変更かを示す。書式は `partKey.ts` の `partLabelOf`(`partLabelMap` と同じ)。
   */
  const partLabels = computed(
    () => new Map(ctx.canvasEntries.value.map((e) => [e.key, partLabelOf(e)])),
  );

  /**
   * canvas の全パーツ(紙面の順)のキー → 表示名。業務名 → 先頭の文字 → `ページN・パーツM` の順
   * (承認タブ・紙面の目印と同じ決め方。`useChangeNumbers.ts` の削除パーツの名前と揃える)。
   * `partLabels` と同じ数え上げ(`canvasEntries`)から作り、全パーツを 2 度数えない。
   */
  const partNames = computed(() => {
    const out = new Map<string, string>();
    for (const e of ctx.canvasEntries.value) {
      out.set(
        e.key,
        partDisplayName({
          catalogName: partNameOf(e.key, nameById.value),
          firstText: partNameOfElement(e.part),
          fallbackLabel: partLabelOf(e),
        }),
      );
    }
    return out;
  });

  // 確定版との差分のあるパーツの番号。比較元・比較先は `open` で決める。開くまでは比較元が null で
  // 計算しない。
  let changeBaseline: string | null = null;
  let filledHtml = '';
  /**
   * 変更の目印を出せるか(比較元がある経路だけ。作成経路・値入り HTML の無いテンプレでは
   * 出さない)。
   */
  const changeMarksAvailable = ref(false);
  const changeNumbers = useChangeNumbers({
    baseline: () => changeBaseline,
    // 本文は振り分けが読んだもの(`lastBody`)を使い、直列化を 2 度しない。`lastBody` が null なのは
    // `reset` の前だけで、計算は `open`(先に `reset` する)のあとでしか走らない(比較元が null の間は
    // 計算しない)ので、右辺は届かない守り(`reset` を飛ばす呼び方に変わっても古い本文を比べない)。
    current: () => submitBodyOf(filledHtml, changeCheck.lastBody() ?? ctx.readBody()),
    nameById: () => nameById.value,
  });
  // 本文が変わった変更だけを予約する(CSS だけの変更では予約しない。`createChangeCheckScheduler`)。
  const changeCheck = createChangeCheckScheduler({
    readBody: ctx.readBody,
    baseline: () => changeBaseline,
    schedule: () => changeNumbers.schedule(),
    onRead: ctx.onBodyRead,
    wantsRead: ctx.wantsBodyRead,
  });
  watch(changeNumbers.numbers, (n) => ctx.setChangeNumbers(n.byKey));

  /**
   * 前回の申請で却下されたパーツの理由(本人のいちばん新しい申請が決着済みのときだけ。条件は
   * `useRejectedReasons.ts`)。`open` で 1 回だけ取る(承認タブから戻れば再マウントで読み直る)。
   */
  const rejectedReasons = useRejectedReasons({
    templateId: ctx.templateId,
    me: ctx.me,
    reviews: ctx.reviews,
    canvasKeys: () => new Set(partNames.value.keys()),
  });

  /**
   * 未選択のときの修正履歴を、変更の番号ごとの見出しへ束ねたもの。変更の目印の出し入れ
   * (`changeMarksEnabled`)とは無関係に、番号が有れば見出しに出す。却下の理由は見出しの下に付け、
   * 今の紙面に無いキーの却下は申請の本文から作った名前で末尾へ並べる。
   */
  const historyGroups = computed(() =>
    groupHistoryByPart({
      entries: ctx.history.value,
      numbers: changeNumbers.numbers.value,
      partOrder: [...partNames.value.keys()],
      nameOf: (key) => partNames.value.get(key) ?? '',
      offCanvasNameOf: (key) => rejectedReasons.reasons.value.get(key)?.name ?? undefined,
      rejected: rejectedReasons.reasons.value,
    }),
  );
  const selectedRejected = computed(
    () => rejectedReasons.reasons.value.get(ctx.selectedKey.value ?? '') ?? null,
  );
  const selectedNo = computed(
    () => changeNumbers.numbers.value.byKey.get(ctx.selectedKey.value ?? '') ?? null,
  );
  const selectedName = computed(() => partNames.value.get(ctx.selectedKey.value ?? '') ?? '');

  /**
   * 本文を canvas へ読み込んだあとに 1 回呼ぶ。番号は確定版の原文(`confirmedBody`)と、申請と
   * 同じ組み立ての本文で比べる。値入り HTML の無いテンプレと作成経路は比較元を持たない(番号を
   * 出さない)。
   * 開いた直後に 1 回計算する。前回の申請の却下の理由は作成経路では取らない(確定版が無く、比べる
   * 前回の申請も無い)。
   */
  function open(input: { isCreateRoute: boolean; filled: string; confirmedBody: string }): void {
    filledHtml = input.filled;
    changeBaseline = changeBaselineOf(input);
    changeMarksAvailable.value = changeBaseline !== null;
    changeCheck.reset();
    void changeNumbers.flush();
    if (!input.isCreateRoute) void rejectedReasons.reload();
  }

  /** 画面を離れるとき: 本文の読みの待ち・番号の予約・計算中の結果を捨てる。 */
  function dispose(): void {
    changeCheck.cancel();
    changeNumbers.cancel();
  }

  return {
    partLabels,
    partNames,
    /** 確定版との差分のあるパーツの番号(作成経路・値入り HTML の無いテンプレでは常に空)。 */
    changeNumbers: changeNumbers.numbers,
    changeMarksAvailable,
    historyGroups,
    selectedNo,
    selectedName,
    selectedRejected,
    open,
    /** canvas の変更の通知(本文が変わったときだけ番号の計算を予約する)。 */
    notify: () => changeCheck.notify(),
    dispose,
  };
}

/**
 * `useTemplateEditor.ts` から `useEditorChangeView` への受け渡し。読み込みの結果から `open` に渡す値を
 * 選び、canvas の変更は即時の処理(dirty・autosave)のあとで `notify` へ、画面を離れるときは `dispose`
 * へ流す。オーケストレーションは GrapesJS 一式を起こすので単体で組めず、受け渡しだけをここで確かめる。
 */
export function wireEditorChangeView(deps: {
  view: Pick<ReturnType<typeof useEditorChangeView>, 'open' | 'notify' | 'dispose'>;
  /** canvas の変更で即時にすること(dirty を立て、autosave を予約する)。 */
  onChange: () => void;
}) {
  return {
    /** 本文を canvas へ読み込んだあと(`loadForEdit` の結果)。 */
    loaded(input: {
      isCreateRoute: boolean;
      template: { filled: string };
      confirmedBody: string;
    }): void {
      deps.view.open({
        isCreateRoute: input.isCreateRoute,
        filled: input.template.filled,
        confirmedBody: input.confirmedBody,
      });
    },
    changed(): void {
      deps.onChange();
      deps.view.notify();
    },
    unmounted(): void {
      deps.view.dispose();
    },
  };
}
