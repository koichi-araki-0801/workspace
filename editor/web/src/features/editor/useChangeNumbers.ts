// =============================================================================
// useChangeNumbers.ts — 編集画面の変更の番号(確定版との差分のあるパーツの丸数字)
// =============================================================================
// 役割: 作業中の版と確定版を承認タブと同じ差分の仕組み(`htmlWorker.buildHtmlDiff` と shared の
// `numberChangedParts`)で比べ、差分のあるパーツへ紙面の上から 1 から番号を振る。紙面の目印
// (`useCanvasMarkers.ts` の `changeMarkers`)と修正履歴の見出しがこの番号を使う。
// 揃え所(計画で決めたこと 22): 比較元は確定版の本文の原文(`loadForEdit` の `confirmedBody`。
// GrapesJS の正規形ではない)、比較先は申請の本文と同じ組み立て(`submitBody.ts`)。承認タブは
// 申請時点の確定版の原文(`baseHtml`)と申請の本文を比べるので、同じ入力になる。
// 番号の一致は保存済みの下書きの時点に限る(申請は保存済みの下書きから組む)。
// worker はプレビュー・比較と共用で、計算の終わる順は呼んだ順と限らないので、連番で古い結果を捨てる。

import {
  type ChangedPart,
  numberChangedParts,
  partDisplayName,
  partNameOfHtml,
  unexpected,
} from '@editor/shared';
import { type Ref, ref } from 'vue';
import { logError } from '@/lib/appError';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { partNameOf } from '@/lib/partNames';
import { htmlWorker } from '@/workers';

/** 差分の予約の最短の待ち。打鍵のたびに文書全体の差分を取らないための下限。 */
const MIN_DEBOUNCE_MS = 1000;

/**
 * 予約が満了した時刻の目印(`performance.mark` の名前)。満了するとすぐ番号の計算を始める(前の
 * 計算がまだ走っていれば、それが終わってから最新の本文で始める)。e2e(`canvas.spec.ts` の所要時間の
 * テスト)が、ここから紙面の目印が出るまでを基準の 1,500ms と比べる。前の目印は消してから打ち、1 つ
 * しか残さない(e2e は `PerformanceObserver` で打たれるたびに受け取る)。
 */
export const CHANGE_RUN_MARK = 'change-numbers:run';

export interface ChangeNumbers {
  /** canvas のキー(after 側の `partKey`) → 番号。紙面にあるパーツ(変更・追加)。 */
  byKey: Map<string, number>;
  /** 紙面に無い(削除した)パーツ。`key` は確定版側のキー(`beforePartKey`)。 */
  removed: { no: number; key: string; name: string }[];
}

const emptyNumbers = (): ChangeNumbers => ({ byKey: new Map(), removed: [] });

interface ChangeNumbersContext {
  /** 確定版の本文の原文(`loadForEdit` の `confirmedBody`)。null なら番号を出さない。 */
  baseline: () => string | null;
  /** 申請の本文と同じ組み立ての本文(`submitBodyOf`。`getBodyHtml()` そのままではない)。 */
  current: () => string;
  /** 既定 1000。1,000ms 未満は 1,000ms にする。 */
  debounceMs?: number;
  /** カタログのパーツ id → 業務名。削除したパーツの名前に使う(承認タブと同じ順で決める)。 */
  nameById?: () => ReadonlyMap<string, string>;
}

/**
 * 番号を振った差分のパーツを、紙面にあるもの(`byKey`)と削除したもの(`removed`)へ分ける。
 * パーツに数えない block(`#attached#`・`#text#`)も番号を持つ(承認タブと同じ数え方)。紙面に
 * 要素が無いので目印は出ないが、番号は飛ばさない。
 */
function splitNumbers(parts: ChangedPart[], nameById: ReadonlyMap<string, string>): ChangeNumbers {
  const out = emptyNumbers();
  for (const p of parts) {
    if (p.afterPage !== null) {
      out.byKey.set(p.partKey, p.no);
      continue;
    }
    const key = p.beforePartKey ?? p.partKey;
    out.removed.push({
      no: p.no,
      key,
      name: partDisplayName({
        catalogName: partNameOf(key, nameById),
        firstText: partNameOfHtml(p.rawBeforeHtml, defaultHtmlParser),
        fallbackLabel: p.label,
      }),
    });
  }
  return out;
}

export function useChangeNumbers(ctx: ChangeNumbersContext): {
  numbers: Ref<ChangeNumbers>;
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
} {
  const numbers = ref<ChangeNumbers>(emptyNumbers());
  const delay = Math.max(MIN_DEBOUNCE_MS, ctx.debounceMs ?? MIN_DEBOUNCE_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 計算を始めるたび・`cancel` のたびに進める。終わったときに最新でなければ結果を捨てる。 */
  let seq = 0;
  /** worker へ投げている計算(1 本だけ)。 */
  let running: Promise<void> | null = null;
  /** 計算中に来た要求の印。終わったら 1 回だけ投げ直す。 */
  let again = false;

  /** 1 回分の計算。計算中にもう一度の要求が来ていれば、結果は古いので当てない。 */
  async function computeOnce(): Promise<void> {
    const mine = ++seq;
    const baseline = ctx.baseline();
    if (baseline === null) {
      numbers.value = emptyNumbers();
      return;
    }
    try {
      const diff = await htmlWorker.buildHtmlDiff(baseline, ctx.current());
      if (mine !== seq || again) return;
      numbers.value = splitNumbers(numberChangedParts(diff), ctx.nameById?.() ?? new Map());
    } catch (e) {
      if (mine !== seq || again) return;
      // 古い番号を残すと、直したパーツと違う場所に丸数字が出る。出さない側へ倒す。
      logError(unexpected('change numbers failed', { cause: e }));
      numbers.value = emptyNumbers();
    }
  }

  /**
   * 計算を要求する。計算中なら worker へ重ねて投げず印だけ立て、終わったら最新の本文で 1 回だけ
   * 投げ直す(大きな文書で計算が予約の間隔より長いと、重ねて投げるほど worker が詰まる)。
   * 返す promise は、投げ直しを含めて計算が落ち着いたときに解決する。
   */
  function compute(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await computeOnce();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function schedule(): void {
    if (ctx.baseline() === null) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      performance.clearMarks(CHANGE_RUN_MARK);
      performance.mark(CHANGE_RUN_MARK);
      void compute();
    }, delay);
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    await compute();
  }

  /** 予約・投げ直しの印・計算中の結果を捨てる(画面を離れるとき)。 */
  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    again = false;
    seq += 1;
  }

  return { numbers, schedule, flush, cancel };
}

/**
 * 番号の比較元。作成経路(`?created=1`)は確定版が無く、値入り HTML(`tpl.filled`)の無いテンプレは
 * 申請の本文が Jinja 復元を通る(`submitBody.ts` の組み立てと違う)ので、どちらも null(番号を
 * 出さない。計画で決めたこと 16)。
 */
export function changeBaselineOf(input: {
  isCreateRoute: boolean;
  filled: string | undefined;
  confirmedBody: string;
}): string | null {
  return input.isCreateRoute || !input.filled ? null : input.confirmedBody;
}

/** canvas の変更の通知から本文を読みに行くまでの待ち(既定)。 */
const CHANGE_CHECK_WAIT_MS = 300;

/**
 * 変更の通知を受けた時刻の目印(`performance.mark` の名前)。e2e(`canvas.spec.ts` の所要時間の
 * テスト)が、通知から紙面の目印が出るまでの全体を記録に残すのに読む(基準の始点は
 * `CHANGE_RUN_MARK`)。e2e はアプリの中を見られないので、時刻はアプリが残す。前の目印は消してから
 * 打ち、長い編集でも 1 つしか残さない(e2e は `PerformanceObserver` で打たれるたびに受け取る)。
 */
export const CHANGE_NOTIFY_MARK = 'change-numbers:notify';

/**
 * canvas の変更の通知を、本文(`getBodyHtml()`)が変わったときだけの差分の予約へ振り分ける。CSS
 * だけの変更や、保存内容の変わらない通知では予約しない(番号はパーツの差分だけで決まり、CSS は
 * 比べない)。通知は style・選択の状態などでも頻繁に来る(ハンドルの drag では連続する)ので、本文の
 * 直列化は通知のたびでなく `waitMs` 待ってから 1 回だけ行う。読んだ本文は `lastBody` で返し、差分の
 * 計算(`useChangeNumbers` の `current`)が同じ本文を使えるようにする(直列化を 2 度しない)。
 * `baseline` が null(番号を出さない経路)の間は予約しない。そのときも `onRead` が本文を要れば
 * (`wantsRead`)、待ちのあとに本文を読んで渡す。
 */
export function createChangeCheckScheduler(opts: {
  readBody: () => string;
  baseline: () => string | null;
  schedule: () => void;
  waitMs?: number;
  /**
   * 待ちのあとに読んだ本文を受け取る(本文が同じでも、`baseline` が null でも呼ぶ)。同じ待ちで
   * 本文を読む別の処理(`useTemplateEditor.ts` の確定版との同一判定)が、直列化をもう 1 度しない
   * ためにある。大きい帳票では本文の直列化が主スレッドを数百 ms 占め、2 度読むと番号の計算が
   * 遅れる。
   */
  onRead?: (body: string) => void;
  /** `onRead` が本文を要るか(既定は常に要る)。要らない間は、番号を出さない経路で本文を読まない。 */
  wantsRead?: () => boolean;
}): {
  /** 今の本文を基準にする(開いた直後)。 */
  reset(): void;
  /** canvas の変更の通知。 */
  notify(): void;
  /** 最後に読んだ本文(`reset` の前は null)。 */
  lastBody(): string | null;
  cancel(): void;
} {
  const wait = opts.waitMs ?? CHANGE_CHECK_WAIT_MS;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    reset() {
      last = opts.readBody();
    },
    notify() {
      const counting = opts.baseline() !== null;
      const reading = () => opts.onRead !== undefined && (opts.wantsRead?.() ?? true);
      if (!counting && !reading()) return;
      if (counting) {
        performance.clearMarks(CHANGE_NOTIFY_MARK);
        performance.mark(CHANGE_NOTIFY_MARK);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (opts.baseline() === null && !reading()) return;
        const body = opts.readBody();
        if (reading()) opts.onRead?.(body);
        // 番号を出さない経路(比較元が null)は、読んだ本文を渡すだけで終える。
        if (opts.baseline() === null || body === last) return;
        last = body;
        opts.schedule();
      }, wait);
    },
    lastBody: () => last,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
