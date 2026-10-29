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
  /** 計算を始めるたびに進める。終わったときに最新でなければ結果を捨てる。 */
  let seq = 0;

  async function compute(): Promise<void> {
    const mine = ++seq;
    const baseline = ctx.baseline();
    if (baseline === null) {
      numbers.value = emptyNumbers();
      return;
    }
    try {
      const diff = await htmlWorker.buildHtmlDiff(baseline, ctx.current());
      if (mine !== seq) return;
      numbers.value = splitNumbers(numberChangedParts(diff), ctx.nameById?.() ?? new Map());
    } catch (e) {
      if (mine !== seq) return;
      // 古い番号を残すと、直したパーツと違う場所に丸数字が出る。出さない側へ倒す。
      logError(unexpected('change numbers failed', { cause: e }));
      numbers.value = emptyNumbers();
    }
  }

  function schedule(): void {
    if (ctx.baseline() === null) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void compute();
    }, delay);
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    await compute();
  }

  /** 予約と計算中の結果を捨てる(画面を離れるとき)。 */
  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
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

/**
 * canvas の変更のうち本文(`getBodyHtml()`)が変わったものだけを通す門。CSS だけの変更や、保存
 * 内容の変わらない通知では差分を予約しない(番号はパーツの差分だけで決まり、CSS は比べない)。
 * `reset` で今の本文を基準にし、`changed` は前に見た本文と違えば true を返して基準を進める。
 */
export function createBodyChangeGate(readBody: () => string): {
  reset(): void;
  changed(): boolean;
} {
  let last: string | null = null;
  return {
    reset() {
      last = readBody();
    },
    changed() {
      const body = readBody();
      if (body === last) return false;
      last = body;
      return true;
    },
  };
}
