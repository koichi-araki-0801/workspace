// =============================================================================
// partSync.ts — 交付版⇄全体版 パーツ自動同期の純関数エンジン
// =============================================================================
// 確定保存の承認直後(`pairSyncService.ts`)に、承認されたテンプレ(source)の変更をペア
// テンプレ(target)へパーツ単位で転写するための計算部。I/O を持たない純関数のみで、
// 入力(HTML 文字列・ポリシー・前回状態)から「新しい target HTML と状態」を導く。
//
// 設計上の要点:
// - 同期対象は `data-part-id` を持つ要素(= パーツカタログ由来)のみ。キーは
//   `partId#n`(同一 partId の文書内出現順)で、web の構造パスキー(`partKey.ts`)とは
//   独立(ページ番号を含めない。ペア間でページ構成が違っても対応づくようにするため)。
// - 置換は DOM を経由せず生テキストの span 差し替えで行う。DOM round-trip は
//   ファイル全体を再整形してしまい、非対象パーツまで差分が出る(テンプレは成果物であり
//   バイト保存が原則)ため。**禁止されているのは再直列化であって、境界の特定手段ではない**
//   — 走査器は自由に差し替えてよい(`SyncPart` は元文字列上の index 対しか持たない)。
// - do-no-harm: 転写するのは「ポリシーが `同期` で、前回同期以降 source だけが変わった」
//   パーツに限る。初期差分・両側変更(競合)・削除・挿入位置不明はすべてスキップして
//   理由を返し、人間の判断に委ねる。

import { createHash } from 'node:crypto';
import type { PartSyncDefault } from '@editor/shared';

// ── 1. パーツ抽出(生テキストスキャン) ──

/** 抽出した 1 パーツ。`start`/`end` は元 HTML 文字列上の outerHTML 範囲(end は排他)。 */
export interface SyncPart {
  partId: string;
  /** `partId#n`(n = 同一 partId の文書内出現順、1 始まり)。状態ファイルのキーにも使う。 */
  key: string;
  start: number;
  end: number;
  html: string;
}

/** 終了タグを持たない HTML void 要素。深さ追跡の対象から外す。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * 走査を受け付ける HTML の最大長(UTF-16 単位)。グローバル `bodyLimit`(`app.ts`)と同値で、
 * 「リクエストとして受け取れる最大」を超える走査は行わない。超過時に空配列でなく throw
 * するのは、空配列だと `computePairSync` が「source にパーツが 1 つも無い」と誤解釈して
 * 状態ファイルを書き換える(サイレントな状態破壊)ため。ベストエフォート層
 * (`pairSyncService` / `noteMasterService`)の既存 catch が warn + skip へ倒す。
 */
export const MAX_SYNC_SCAN_BYTES = 8 * 1024 * 1024;

/** 中身をタグとして解釈しない要素(HTML の RAWTEXT/ESCAPABLE RAWTEXT)。 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** タグ 1 個分の走査結果。`attrsFrom`/`attrsTo` は開始タグの属性区間(end は排他)。 */
interface HtmlToken {
  kind: 'start' | 'end';
  /** 小文字化したタグ名。 */
  name: string;
  /** `<` の位置。 */
  start: number;
  /** `>` の次の位置(排他)。 */
  end: number;
  selfClosing: boolean;
  attrsFrom: number;
  attrsTo: number;
}

const isSpace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNameStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isNameChar = (c: string): boolean => isNameStart(c) || (c >= '0' && c <= '9') || c === '-';

/**
 * HTML をタグ単位に走査する。**不変則: カーソル `i` は単調非減少で、決して戻さない**
 * — 前進は `indexOf` か 1 文字進みのみ。これが線形性の唯一の根拠であり、
 * 「閉じ引用符が無いのでこの `<` は文字データだった」と解釈し直して巻き戻す実装を
 * 書いた瞬間に二次計算量(バックトラック型正規表現の ReDoS と同型)が復活する。
 * 閉じられない引用符・閉じられない `>` は**走査全体の打ち切り**で表現すること。
 *
 * コメント・doctype・処理命令はトークンを出さずに読み飛ばす。RAWTEXT 要素
 * (`script` 等)は開始タグを出したあと、対応する終了タグまでを丸ごと飛ばす
 * (中身にタグを見出さない = ブラウザと同じ解釈)。
 */
function* tokenizeHtml(html: string): Generator<HtmlToken> {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;
    i = lt + 1;
    if (html.startsWith('!--', i)) {
      const close = html.indexOf('-->', i + 3);
      if (close < 0) return;
      i = close + 3;
      continue;
    }
    const head = html[i];
    if (head === '!' || head === '?') {
      const gt = html.indexOf('>', i);
      if (gt < 0) return;
      i = gt + 1;
      continue;
    }
    const isClose = head === '/';
    if (isClose) i++;
    const nameStart = i;
    if (i < n && isNameStart(html[i])) {
      i++;
      while (i < n && isNameChar(html[i])) i++;
    }
    // タグ名にならない `<` は文字データ。`i` は既に `lt` より先なので巻き戻さない。
    if (i === nameStart) continue;
    const name = html.slice(nameStart, i).toLowerCase();
    const attrsFrom = i;
    let end = -1;
    while (i < n) {
      const c = html[i];
      if (c === '"' || c === "'") {
        const q = html.indexOf(c, i + 1);
        if (q < 0) return; // 閉じ引用符なし = 打ち切り(戻り読み禁止)
        i = q + 1;
        continue;
      }
      if (c === '>') {
        end = i + 1;
        break;
      }
      i++;
    }
    if (end < 0) return; // 閉じ `>` なし = 打ち切り
    const attrsTo = end - 1;
    const selfClosing = attrsTo > attrsFrom && html[attrsTo - 1] === '/';
    yield {
      kind: isClose ? 'end' : 'start',
      name,
      start: lt,
      end,
      selfClosing,
      attrsFrom,
      attrsTo,
    };
    i = end;
    if (isClose || selfClosing || !RAW_TEXT_TAGS.has(name)) continue;
    // RAWTEXT: 最初に現れる `</name` で終わる(引用符を考慮して探すと二次の温床になる)。
    let p = i;
    let closeAt = -1;
    while (p < n) {
      const k = html.indexOf('</', p);
      if (k < 0) break;
      const after = k + 2 + name.length;
      if (html.slice(k + 2, after).toLowerCase() === name) {
        const c = html[after];
        if (c === undefined || isSpace(c) || c === '/' || c === '>') {
          closeAt = k;
          break;
        }
      }
      p = k + 2;
    }
    if (closeAt < 0) return;
    const gt = html.indexOf('>', closeAt);
    if (gt < 0) return;
    yield {
      kind: 'end',
      name,
      start: closeAt,
      end: gt + 1,
      selfClosing: false,
      attrsFrom: closeAt + 2 + name.length,
      attrsTo: gt,
    };
    i = gt + 1;
  }
}

/**
 * 開始タグの属性区間から `data-part-id` の値を取り出す。無ければ null。引用符あり・
 * 引用符なし(`data-part-id=foo`)の双方を拾う — 引用符付きしか見ない判定では、
 * 引用符なしのパーツが同期対象から静かに落ちる。
 */
function findPartId(html: string, from: number, to: number): string | null {
  let i = from;
  while (i < to) {
    while (i < to && (isSpace(html[i]) || html[i] === '/')) i++;
    if (i >= to) return null;
    const ns = i;
    while (i < to && !isSpace(html[i]) && html[i] !== '=' && html[i] !== '/') i++;
    const name = html.slice(ns, i).toLowerCase();
    while (i < to && isSpace(html[i])) i++;
    if (html[i] !== '=' || i >= to) {
      if (name === 'data-part-id') return null; // 値なし属性はパーツ id として扱わない
      continue;
    }
    i++;
    while (i < to && isSpace(html[i])) i++;
    const q = html[i];
    let value: string;
    if (q === '"' || q === "'") {
      const e = html.indexOf(q, i + 1);
      if (e < 0 || e >= to) {
        value = html.slice(i + 1, to);
        i = to;
      } else {
        value = html.slice(i + 1, e);
        i = e + 1;
      }
    } else {
      const vs = i;
      while (i < to && !isSpace(html[i])) i++;
      value = html.slice(vs, i);
    }
    if (name === 'data-part-id') return value;
  }
  return null;
}

/**
 * HTML から `data-part-id` 付き要素の outerHTML 範囲を文書順に抽出する。パーツはページ
 * 直下の兄弟という前提で、パーツ内部に入れ子の `data-part-id` があっても外側に内包する
 * (別パーツとして数えない)。同名タグの入れ子は深さ追跡で正しく閉じ位置を判定する。
 *
 * `MAX_SYNC_SCAN_BYTES` 超過は throw する(空配列を返さない理由は同定数の doc を参照)。
 */
export function extractSyncParts(html: string): SyncPart[] {
  if (html.length > MAX_SYNC_SCAN_BYTES)
    throw new Error(
      `同期対象の HTML が大きすぎます(${html.length} 文字 > 上限 ${MAX_SYNC_SCAN_BYTES})`,
    );
  const parts: SyncPart[] = [];
  const counts = new Map<string, number>();
  const push = (partId: string, start: number, end: number): void => {
    const n = (counts.get(partId) ?? 0) + 1;
    counts.set(partId, n);
    parts.push({ partId, key: `${partId}#${n}`, start, end, html: html.slice(start, end) });
  };

  // 走査中のパーツ(open)が閉じるまでは新たなパーツを開始しない。
  let open: { tag: string; partId: string; start: number; depth: number } | null = null;
  for (const t of tokenizeHtml(html)) {
    const isClose = t.kind === 'end';
    const isSelfClose = t.selfClosing || VOID_TAGS.has(t.name);

    if (open) {
      if (isClose && t.name === open.tag) {
        open.depth--;
        if (open.depth === 0) {
          push(open.partId, open.start, t.end);
          open = null;
        }
      } else if (!isClose && t.name === open.tag && !isSelfClose) {
        open.depth++;
      }
      continue;
    }
    if (isClose) continue;
    const partId = findPartId(html, t.attrsFrom, t.attrsTo);
    if (partId === null) continue;
    if (isSelfClose) push(partId, t.start, t.end);
    else open = { tag: t.name, partId, start: t.start, depth: 1 };
  }
  return parts;
}

// ── 2. 同期状態(ペア単位・パーツ別) ──

/**
 * パーツ 1 件の同期状態。`lastSynced` は「最後に両版が一致していた時点」のパーツ内容
 * SHA-1 で、これと現在の両版を比べて「どちらが変わったか」を判定する。競合(初期差分・
 * 両側変更)を検出したら `conflict` に記録し、解消(内容一致 or 転写成功)で消す。
 */
export interface PairPartState {
  lastSynced?: string;
  conflict?: { kind: '初期差分' | '両側変更' | 'ペア側先行'; detectedAt: string };
}

/** ペア 1 組の同期状態(`sync/<pairKey>.json` の中身。I/O は `syncFiles.ts`)。 */
export interface PairSyncState {
  pairKey: string;
  parts: Record<string, PairPartState>;
  updatedAt: string;
}

export function emptySyncState(pairKey: string): PairSyncState {
  return { pairKey, parts: {}, updatedAt: '' };
}

function contentHash(html: string): string {
  return createHash('sha1').update(html).digest('hex');
}

// ── 3. 同期計算(転写・競合判定・状態更新) ──

export interface PairSyncComputeInput {
  sourceHtml: string;
  targetHtml: string;
  /** partId → 同期既定(パーツカタログ台帳の `同期既定` 列)。未登録 id は未判断扱い。 */
  syncDefaults: ReadonlyMap<string, PartSyncDefault | null | undefined>;
  /** 版固有宣言(`交付版のみ` 等)の照合に使う両版の版種。 */
  sourceEdition: string;
  targetEdition: string;
  state: PairSyncState;
  /** 競合記録・状態更新のタイムスタンプ(ISO)。テスト容易性のため注入する。 */
  now: string;
}

export interface PairSyncComputeResult {
  targetHtml: string;
  /** target HTML に転写(置換/挿入)が発生したか。 */
  changed: boolean;
  applied: string[];
  skipped: { partKey: string; reason: string }[];
  state: PairSyncState;
  /** 状態(lastSynced/競合/掃除)が入力から変わったか。false なら書き戻し不要。 */
  stateChanged: boolean;
}

/** target HTML への編集操作。span は互いに重ならない(パーツ範囲は排他 + 挿入は境界点)。 */
export interface EditOp {
  start: number;
  end: number;
  text: string;
  /** 同一位置への複数挿入(連続 added)で source 順を保つための通し番号。 */
  seq: number;
}

/**
 * 非重複の編集操作列を文字列連結で適用する(DOM round-trip をしない = 非対象範囲は
 * バイト不変)。ペア同期の転写のほか、注記マスタの生成時適用(`noteMasterService.ts`)も
 * 同じ「span 差し替え」規約を共有するため export する。
 */
export function applyOps(html: string, ops: EditOp[]): string {
  const sorted = [...ops].sort((a, b) => a.start - b.start || a.seq - b.seq);
  let out = '';
  let cursor = 0;
  for (const op of sorted) {
    out += html.slice(cursor, op.start) + op.text;
    cursor = op.end;
  }
  return out + html.slice(cursor);
}

// キー順・フィールド順に依存しない比較用の正規形。ファイル由来(任意順)と計算結果を
// 素の JSON.stringify で比べると順序差だけで「変更あり」になり、無意味な書き戻し
// (= git コミット)が出るため。
function canonicalParts(parts: Record<string, PairPartState>): string {
  return JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((k) => [
        k,
        parts[k].lastSynced ?? null,
        parts[k].conflict?.kind ?? null,
        parts[k].conflict?.detectedAt ?? null,
      ]),
  );
}

/** 重複 id をスキップした理由(呼び出し側の報告文とテストが参照する)。 */
const DUPLICATE_ID_REASON = '重複 id(同一 partId が複数出現・位置対応が不確実)';

/**
 * いずれかの版で同一 partId が 2 回以上出現する partId の集合。
 *
 * パーツキー `partId#n` の n は「同一 partId の文書内出現順」でしかないため、先頭の 1 件が
 * 消えると後続が繰り上がり、別のパーツどうしが対応づく。転写は生テキストの span 置換なので、
 * その誤対応はそのまま本文の取り違えになる。#n を安定させる手段は文書内に無いので、
 * 重複する partId は同期対象から外して人間へ返す(安全側)。
 */
function duplicatedPartIds(...groups: readonly (readonly SyncPart[])[]): Set<string> {
  const dup = new Set<string>();
  for (const parts of groups) {
    const seen = new Set<string>();
    for (const p of parts) {
      if (seen.has(p.partId)) dup.add(p.partId);
      else seen.add(p.partId);
    }
  }
  return dup;
}

/**
 * ペア同期の本体。source(承認直後のテンプレ)の変更を target(ペア)へ転写した結果と、
 * 更新後の同期状態を返す。入力は破壊しない。判定はパーツキー単位で:
 *
 * | 状況                                   | 挙動                                   |
 * |----------------------------------------|----------------------------------------|
 * | 両版一致                               | lastSynced を取り直す(ベースライン)    |
 * | source のみ変更(lastSynced = target)   | 転写(唯一の自動書き換え)               |
 * | target のみ変更(lastSynced = source)   | スキップ(逆方向の承認時に同期される)   |
 * | 一致履歴なしで差分                     | 競合「初期差分」を記録してスキップ     |
 * | 両側変更                               | 競合「両側変更」を記録してスキップ     |
 * | source にのみ存在(追加)                | 直前パーツを錨に挿入。錨なしはスキップ |
 * | target にのみ存在(削除 or 版固有)      | 削除は自動同期しない(同期履歴あれば報告)|
 */
export function computePairSync(input: PairSyncComputeInput): PairSyncComputeResult {
  const srcParts = extractSyncParts(input.sourceHtml);
  const tgtParts = extractSyncParts(input.targetHtml);
  const srcMap = new Map(srcParts.map((p) => [p.key, p]));
  const tgtMap = new Map(tgtParts.map((p) => [p.key, p]));

  const applied: string[] = [];
  const skipped: { partKey: string; reason: string }[] = [];
  // どちらかの版で重複する partId は位置対応が立たないので、丸ごと同期対象外にする。
  const duplicated = duplicatedPartIds(srcParts, tgtParts);
  const reportedDuplicates = new Set<string>();
  /** 重複 id の報告は partId ごとに 1 回だけ出す(出現数ぶん並べても判断材料が増えない)。 */
  const reportDuplicate = (partId: string, partKey: string): void => {
    if (reportedDuplicates.has(partId)) return;
    reportedDuplicates.add(partId);
    skipped.push({ partKey, reason: DUPLICATE_ID_REASON });
  };
  const ops: EditOp[] = [];
  const newParts: Record<string, PairPartState> = {};
  let seq = 0;

  // 連続 added の挿入位置: 直前に処理した source パーツの「target 上の終端」。既存パーツは
  // その span 終端、挿入したパーツは錨と同位置(seq が source 順を保証)を引き継ぐ。
  let insertAnchor: number | null = null;

  const policyOf = (partId: string): PartSyncDefault | null =>
    input.syncDefaults.get(partId) ?? null;

  for (const src of srcParts) {
    const key = src.key;
    const prev = input.state.parts[key];
    const tgt = tgtMap.get(key);
    const policy = policyOf(src.partId);

    if (duplicated.has(src.partId)) {
      reportDuplicate(src.partId, key);
      if (prev) newParts[key] = prev;
      if (tgt) insertAnchor = tgt.end;
      continue;
    }

    // 版固有宣言・非同期は転写もベースラインも取らない(意図的な独立メンテ)。
    if (policy === '非同期') {
      if (tgt) insertAnchor = tgt.end;
      continue;
    }
    if (policy === `${input.sourceEdition}のみ` || policy === `${input.targetEdition}のみ`) {
      if (tgt) insertAnchor = tgt.end;
      continue;
    }
    if (policy !== '同期') {
      // 未判断(null / カタログ外)。差分があるときだけ「要判断」として報せる(騒音抑制)。
      if (tgt) {
        if (contentHash(src.html) !== contentHash(tgt.html))
          skipped.push({ partKey: key, reason: '未判断(同期既定が未設定)' });
        if (prev) newParts[key] = prev;
        insertAnchor = tgt.end;
      }
      continue;
    }

    if (tgt) {
      const hs = contentHash(src.html);
      const ht = contentHash(tgt.html);
      if (hs === ht) {
        // 一致 = 同期済み。ベースラインを取り直し、残っていた競合記録は解消する。
        newParts[key] = { lastSynced: hs };
      } else if (prev?.lastSynced === ht) {
        // target は前回同期から不変で source だけが変わった = 唯一の自動転写ケース。
        ops.push({ start: tgt.start, end: tgt.end, text: src.html, seq: seq++ });
        applied.push(key);
        newParts[key] = { lastSynced: hs };
      } else if (prev?.lastSynced === hs) {
        // source 側は前回同期から不変。target が先行して変わっており、この方向の承認では
        // 触らない(target 側の承認時に逆方向の同期が拾う)。
        //
        // 転写しないだけでなく**状態へ痕跡を残す**: 記録しないと編集画面のバナー
        // (`getPairSyncStatus`)に出ず、承認直後の summary を見逃した時点で誰も気付けない
        // まま固定される。`lastSynced` は据え置き(進めると次回に両側変更を見落とす)。
        // 逆方向の承認で転写が走れば `{ lastSynced }` で上書きされ、この記録は消える。
        skipped.push({ partKey: key, reason: 'ペア側が先行変更(逆方向の承認時に同期)' });
        newParts[key] = {
          lastSynced: prev.lastSynced,
          conflict: prev.conflict ?? { kind: 'ペア側先行', detectedAt: input.now },
        };
      } else if (!prev?.lastSynced) {
        skipped.push({ partKey: key, reason: '初期差分(一致履歴なし・要判断)' });
        newParts[key] = { conflict: prev?.conflict ?? { kind: '初期差分', detectedAt: input.now } };
      } else {
        skipped.push({ partKey: key, reason: '競合(前回同期以降に両側で変更)' });
        newParts[key] = {
          lastSynced: prev.lastSynced,
          conflict: prev.conflict ?? { kind: '両側変更', detectedAt: input.now },
        };
      }
      insertAnchor = tgt.end;
    } else {
      // source にのみ存在(追加)。直前パーツの target 終端を錨に挿入する。文頭錨(target の
      // 先頭パーツより前)は構成差の誤挿入リスクが高いので採らず、錨なしはスキップに倒す。
      if (insertAnchor !== null) {
        ops.push({ start: insertAnchor, end: insertAnchor, text: `\n${src.html}`, seq: seq++ });
        applied.push(key);
        newParts[key] = { lastSynced: contentHash(src.html) };
        // insertAnchor は据え置き(連続 added は seq が並び順を保つ)。
      } else {
        skipped.push({ partKey: key, reason: '挿入位置を特定できない(ペア側へ手動追加)' });
        if (prev) newParts[key] = prev;
      }
    }
  }

  // target にのみ存在するパーツ: 削除の自動同期はしない。過去に同期していた(= source 側で
  // 意図的に消された可能性が高い)ものだけ報告する。版固有宣言・非同期は正当な片側存在。
  for (const tgt of tgtParts) {
    if (srcMap.has(tgt.key)) continue;
    const prev = input.state.parts[tgt.key];
    const policy = policyOf(tgt.partId);
    if (duplicated.has(tgt.partId)) reportDuplicate(tgt.partId, tgt.key);
    else if (policy === '同期' && prev?.lastSynced)
      skipped.push({ partKey: tgt.key, reason: 'ソース側で削除(削除は自動同期しない)' });
    if (prev) newParts[tgt.key] = prev;
  }

  // 両版から消えたキーの状態は持ち越さない(掃除)。newParts に載せた分だけが生き残る。
  const stateChanged = canonicalParts(input.state.parts) !== canonicalParts(newParts);
  const changed = ops.length > 0;
  return {
    targetHtml: changed ? applyOps(input.targetHtml, ops) : input.targetHtml,
    changed,
    applied,
    skipped,
    state: { pairKey: input.state.pairKey, parts: newParts, updatedAt: input.now },
    stateChanged,
  };
}
