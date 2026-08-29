// =============================================================================
// pre-push.test.mjs — pre-push 振り分けの判定を固定する
// =============================================================================
// 判定の入力は「stdin から読んだ更新 ref」と「upstream に対する先行コミット数」の 2 つ。
// stdin は起動経路によっては refs があるのに空で届く(フック内から `execSync('git push')`
// した場合の実測)。空 stdin を無条件に「対象なし」と解釈すると、その経路の push だけ
// CI ゲートが無言で消えるため、空のときは実差分で判定することをここで固定する。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countAheadOfUpstream, decidePrePushAction } from './pre-push.mjs';

test('ブランチ ref を含む push は CI を実行する', () => {
  const refs = ['refs/heads/chore/deps-latest-offline-bundle'];
  assert.equal(decidePrePushAction(refs, 0), 'ci');
});

test('タグのみの push は先行コミットがあっても CI をスキップする', () => {
  // post-commit のローリングタグ移動は「コミット直後・ブランチ未 push」のタイミングで
  // 走るため aheadCount > 0 になる。ここで CI を走らせるとタグ push が数分ブロックされ、
  // 従来の「タグのみはスキップ」の動線が壊れる。タグ判定は aheadCount より優先する。
  assert.equal(decidePrePushAction(['refs/tags/offline-bundle-v1'], 5), 'skip');
});

test('タグとブランチが混在する push は CI を実行する', () => {
  const refs = ['refs/tags/offline-bundle-v1', 'refs/heads/main'];
  assert.equal(decidePrePushAction(refs, 0), 'ci');
});

test('refs が空でも upstream より先行していれば CI を実行する(stdin 欠落の穴)', () => {
  assert.equal(decidePrePushAction([], 10), 'ci');
});

test('refs が空で先行コミットも無ければスキップする(本当に push 対象なし)', () => {
  assert.equal(decidePrePushAction([], 0), 'skip');
});

test('refs が空で先行数も分からなければ安全側で CI を実行する(upstream 未設定など)', () => {
  assert.equal(decidePrePushAction([], null), 'ci');
});

test('countAheadOfUpstream は非負整数か null を返す', () => {
  const n = countAheadOfUpstream();
  assert.ok(n === null || (Number.isInteger(n) && n >= 0), String(n));
});
