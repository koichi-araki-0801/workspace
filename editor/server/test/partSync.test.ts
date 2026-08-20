// partSync(交付版⇄全体版 パーツ自動同期エンジン)の単体テスト。ハッシュ値をテスト側で
// 手計算せず、「両版一致で 1 回実行 → baseline 状態を得る → 片側を変えて再実行」という
// 実運用と同じ経路で状態遷移を検証する。
import { describe, expect, it } from 'vitest';
import {
  computePairSync,
  emptySyncState,
  extractSyncParts,
  type PairSyncComputeInput,
  type PairSyncState,
} from '../src/sync/partSync.js';

const part = (id: string, text: string): string =>
  `<section data-part-id="${id}"><p>${text}</p></section>`;
const doc = (...parts: string[]): string =>
  `<html><body><div class="page">\n${parts.join('\n')}\n</div></body></html>`;

const run = (
  over: Partial<PairSyncComputeInput> & Pick<PairSyncComputeInput, 'sourceHtml' | 'targetHtml'>,
  defaults: Record<string, '同期' | '非同期' | '交付版のみ' | '全体版のみ' | null> = {},
) =>
  computePairSync({
    syncDefaults: new Map(Object.entries(defaults)),
    sourceEdition: '交付版',
    targetEdition: '全体版',
    state: emptySyncState('AM01_510037_20240710'),
    now: '2026-08-02T00:00:00.000Z',
    ...over,
  });

/** 両版一致の 1 回目実行で lastSynced を確立した状態を得る(初期化と同じ経路)。 */
const baselineOf = (html: string, defaults: Record<string, '同期'>): PairSyncState =>
  run({ sourceHtml: html, targetHtml: html }, defaults).state;

describe('extractSyncParts', () => {
  it('data-part-id 付き要素を文書順に outerHTML 範囲つきで抽出する', () => {
    const html = doc(part('a', 'A'), part('b', 'B'));
    const parts = extractSyncParts(html);
    expect(parts.map((p) => p.key)).toEqual(['a#1', 'b#1']);
    expect(parts[0].html).toBe(part('a', 'A'));
    expect(html.slice(parts[1].start, parts[1].end)).toBe(part('b', 'B'));
  });

  it('同名タグの入れ子を深さ追跡で正しく閉じる', () => {
    const nested = `<div data-part-id="n"><div><div>deep</div></div></div>`;
    const parts = extractSyncParts(doc(nested, part('b', 'B')));
    expect(parts[0].html).toBe(nested);
    expect(parts[1].key).toBe('b#1');
  });

  it('コメント内のタグと属性値内の > を誤検出しない', () => {
    const html = doc(
      `<!-- <section data-part-id="ghost"> -->`,
      `<section data-part-id="a" title="1 > 0"><p>A</p></section>`,
    );
    const parts = extractSyncParts(html);
    expect(parts.map((p) => p.partId)).toEqual(['a']);
  });

  it('同一 partId の複数出現は #n で区別する', () => {
    const parts = extractSyncParts(doc(part('a', '1'), part('a', '2')));
    expect(parts.map((p) => p.key)).toEqual(['a#1', 'a#2']);
  });

  it('パーツ内部の入れ子 data-part-id は外側パーツに内包する', () => {
    const outer = `<section data-part-id="o"><div data-part-id="inner">x</div></section>`;
    const parts = extractSyncParts(doc(outer));
    expect(parts.map((p) => p.key)).toEqual(['o#1']);
  });
});

describe('computePairSync: 転写(唯一の自動書き換え)', () => {
  it('両版一致 → 転写なしで lastSynced ベースラインを確立する', () => {
    const html = doc(part('a', 'A'));
    const r = run({ sourceHtml: html, targetHtml: html }, { a: '同期' });
    expect(r.changed).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.stateChanged).toBe(true);
    expect(r.state.parts['a#1'].lastSynced).toBeTruthy();
  });

  it('source のみ変更 → 転写し、非対象領域はバイト不変', () => {
    const before = doc(part('a', 'A'), part('b', 'B'));
    const state = baselineOf(before, { a: '同期', b: '同期' });
    const source = doc(part('a', 'A2'), part('b', 'B'));
    const r = run({ sourceHtml: source, targetHtml: before, state }, { a: '同期', b: '同期' });
    expect(r.applied).toEqual(['a#1']);
    expect(r.targetHtml).toBe(source);
    // 転写後の再実行は何も変えない(冪等)。
    const again = run(
      { sourceHtml: source, targetHtml: r.targetHtml, state: r.state },
      { a: '同期', b: '同期' },
    );
    expect(again.changed).toBe(false);
    expect(again.stateChanged).toBe(false);
  });

  it('source にのみ存在(追加) → 直前パーツを錨に挿入する', () => {
    const before = doc(part('a', 'A'));
    const state = baselineOf(before, { a: '同期' });
    const source = doc(part('a', 'A'), part('new1', 'N1'), part('new2', 'N2'));
    const r = run(
      { sourceHtml: source, targetHtml: before, state },
      { a: '同期', new1: '同期', new2: '同期' },
    );
    expect(r.applied).toEqual(['new1#1', 'new2#1']);
    // 挿入は錨(a)直後・source の並び順どおり。
    const keys = extractSyncParts(r.targetHtml).map((p) => p.key);
    expect(keys).toEqual(['a#1', 'new1#1', 'new2#1']);
  });
});

describe('computePairSync: スキップ(人間に返すケース)', () => {
  it('一致履歴なしの差分 → 初期差分としてスキップし競合を記録する', () => {
    const r = run(
      { sourceHtml: doc(part('a', 'X')), targetHtml: doc(part('a', 'Y')) },
      { a: '同期' },
    );
    expect(r.changed).toBe(false);
    expect(r.skipped[0].reason).toContain('初期差分');
    expect(r.state.parts['a#1'].conflict?.kind).toBe('初期差分');
  });

  it('両側変更 → 競合としてスキップし lastSynced は保持する', () => {
    const before = doc(part('a', 'A'));
    const state = baselineOf(before, { a: '同期' });
    const r = run(
      { sourceHtml: doc(part('a', 'S')), targetHtml: doc(part('a', 'T')), state },
      { a: '同期' },
    );
    expect(r.changed).toBe(false);
    expect(r.skipped[0].reason).toContain('競合');
    expect(r.state.parts['a#1'].conflict?.kind).toBe('両側変更');
    expect(r.state.parts['a#1'].lastSynced).toBe(state.parts['a#1'].lastSynced);
  });

  it('target のみ先行変更 → この方向では触らない(逆方向の承認時に同期)', () => {
    const before = doc(part('a', 'A'));
    const state = baselineOf(before, { a: '同期' });
    const r = run({ sourceHtml: before, targetHtml: doc(part('a', 'T')), state }, { a: '同期' });
    expect(r.changed).toBe(false);
    expect(r.skipped[0].reason).toContain('ペア側が先行変更');
  });

  it('未判断(同期既定なし)は差分があるときだけ要判断として報せる', () => {
    const same = run({ sourceHtml: doc(part('u', 'U')), targetHtml: doc(part('u', 'U')) });
    expect(same.skipped).toEqual([]);
    const diff = run({ sourceHtml: doc(part('u', 'U1')), targetHtml: doc(part('u', 'U2')) });
    expect(diff.skipped[0].reason).toContain('未判断');
    expect(diff.changed).toBe(false);
  });

  it('挿入の錨が無い(先頭パーツの追加)はスキップに倒す', () => {
    const r = run(
      { sourceHtml: doc(part('new', 'N'), part('a', 'A')), targetHtml: doc(part('a', 'A')) },
      { new: '同期', a: '同期' },
    );
    expect(r.applied).toEqual([]);
    expect(r.skipped.some((s) => s.reason.includes('挿入位置'))).toBe(true);
  });

  it('source 側で削除されたパーツは自動削除せず、同期履歴があるときだけ報せる', () => {
    const before = doc(part('a', 'A'), part('b', 'B'));
    const state = baselineOf(before, { a: '同期', b: '同期' });
    const r = run(
      { sourceHtml: doc(part('a', 'A')), targetHtml: before, state },
      { a: '同期', b: '同期' },
    );
    expect(r.changed).toBe(false);
    expect(r.skipped.some((s) => s.partKey === 'b#1' && s.reason.includes('削除'))).toBe(true);
    // 同期履歴なしの target 専用パーツは報せない(版差として正当)。
    const quiet = run(
      { sourceHtml: doc(part('a', 'A')), targetHtml: before },
      { a: '同期', b: '同期' },
    );
    expect(quiet.skipped.some((s) => s.partKey === 'b#1')).toBe(false);
  });
});

describe('computePairSync: ポリシーと状態管理', () => {
  it('非同期・版固有宣言のパーツは転写もベースラインも取らない', () => {
    const src = doc(part('x', 'S'), part('y', 'S'));
    const tgt = doc(part('x', 'T'), part('y', 'T'));
    const r = run({ sourceHtml: src, targetHtml: tgt }, { x: '非同期', y: '全体版のみ' });
    expect(r.changed).toBe(false);
    expect(r.skipped).toEqual([]);
    expect(r.state.parts).toEqual({});
  });

  it('両版から消えたキーの状態は掃除する', () => {
    const state: PairSyncState = {
      pairKey: 'AM01_510037_20240710',
      parts: { 'gone#1': { lastSynced: 'deadbeef' } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const html = doc(part('a', 'A'));
    const r = run({ sourceHtml: html, targetHtml: html, state }, { a: '同期' });
    expect(r.state.parts['gone#1']).toBeUndefined();
    expect(r.stateChanged).toBe(true);
  });
});

describe('同一 partId の複数出現', () => {
  // 位置キー `partId#n` は「同一 partId の文書内出現順」でしかないため、先頭の 1 件が
  // 消えると 2 件目が #1 へ繰り上がり、別のパーツどうしが対応づく。転写は生テキストの
  // span 置換なので、その誤対応はそのまま本文の取り違えになる。安全側へ倒して同期対象外
  // にすることを固定する。
  it('target で 2 回出る partId は source で 1 回になっても転写しない', () => {
    const both = doc(part('a', '1'), part('a', '2'));
    const state = baselineOf(both, { a: '同期' });
    // source から先頭の a を消す。位置キーだけで対応づけると「a#1 が 2 に変わった」と
    // 読めてしまい、target の 1 件目が 2 件目の内容で潰れる。
    const src = doc(part('a', '2'));
    const r = run({ sourceHtml: src, targetHtml: both, state }, { a: '同期' });

    expect(r.changed).toBe(false);
    expect(r.targetHtml).toBe(both);
    expect(r.applied).toEqual([]);
    expect(r.skipped.some((s) => s.reason.includes('重複 id'))).toBe(true);
  });

  it('source で 2 回出る partId は target が 1 件でも転写しない', () => {
    const src = doc(part('a', '1'), part('a', '2'));
    const tgt = doc(part('a', '1'));
    const r = run({ sourceHtml: src, targetHtml: tgt }, { a: '同期' });

    expect(r.changed).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.skipped.some((s) => s.reason.includes('重複 id'))).toBe(true);
  });

  it('重複していない他のパーツの転写は妨げない', () => {
    const both = doc(part('a', '1'), part('a', '2'), part('b', 'B'));
    const state = baselineOf(both, { a: '同期', b: '同期' });
    const src = doc(part('a', '1'), part('a', '2'), part('b', 'B2'));
    const r = run({ sourceHtml: src, targetHtml: both, state }, { a: '同期', b: '同期' });

    expect(r.applied).toEqual(['b#1']);
    expect(r.targetHtml).toContain('B2');
    expect(r.targetHtml).toContain(part('a', '1'));
  });
});
