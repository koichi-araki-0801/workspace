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
//   バイト保存が原則)ため。
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

// コメントとタグをひとまとめに走査する。属性値内の `>` を誤検出しないよう、引用符付き
// 属性値はグループ 2 の交代で丸ごと読み飛ばす(Jinja の `{{ }}` が属性に居ても安全)。
const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

const PART_ID_RE = /(?:^|\s)data-part-id\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** 開始タグの属性テキストから data-part-id の値を取り出す。無ければ null。 */
function partIdOf(attrs: string): string | null {
  const m = PART_ID_RE.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/**
 * HTML から `data-part-id` 付き要素の outerHTML 範囲を文書順に抽出する。パーツはページ
 * 直下の兄弟という前提で、パーツ内部に入れ子の `data-part-id` があっても外側に内包する
 * (別パーツとして数えない)。同名タグの入れ子は深さ追跡で正しく閉じ位置を判定する。
 */
export function extractSyncParts(html: string): SyncPart[] {
  const parts: SyncPart[] = [];
  const counts = new Map<string, number>();
  const push = (partId: string, start: number, end: number): void => {
    const n = (counts.get(partId) ?? 0) + 1;
    counts.set(partId, n);
    parts.push({ partId, key: `${partId}#${n}`, start, end, html: html.slice(start, end) });
  };

  // 走査中のパーツ(open)が閉じるまでは新たなパーツを開始しない。
  let open: { tag: string; partId: string; start: number; depth: number } | null = null;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m !== null; m = TAG_RE.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    const tag = (m[1] ?? '').toLowerCase();
    const isClose = m[0].startsWith('</');
    const isSelfClose = /\/>$/.test(m[0]) || VOID_TAGS.has(tag);

    if (open) {
      if (isClose && tag === open.tag) {
        open.depth--;
        if (open.depth === 0) {
          push(open.partId, open.start, m.index + m[0].length);
          open = null;
        }
      } else if (!isClose && tag === open.tag && !isSelfClose) {
        open.depth++;
      }
      continue;
    }
    if (isClose) continue;
    const partId = partIdOf(m[2] ?? '');
    if (partId === null) continue;
    if (isSelfClose) push(partId, m.index, m.index + m[0].length);
    else open = { tag, partId, start: m.index, depth: 1 };
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
  conflict?: { kind: '初期差分' | '両側変更'; detectedAt: string };
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
        skipped.push({ partKey: key, reason: 'ペア側が先行変更(逆方向の承認時に同期)' });
        newParts[key] = prev;
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
    if (policy === '同期' && prev?.lastSynced)
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
