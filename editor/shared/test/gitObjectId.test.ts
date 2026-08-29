// =============================================================================
// gitObjectId.test.ts — `historyId` を git へ渡してよいか判定する形式検査
// =============================================================================
// server は `historyId` をそのまま `git show` のリビジョン引数にする。`-` 始まりの値が
// 通ると git がオプション(`--output=<file>` 等)として解釈するため、その形が確実に
// 落ちることを固定する(オプション注入の回帰)。
import { describe, expect, it } from 'vitest';
import { isGitObjectId } from '../src/domain/history';

describe('isGitObjectId', () => {
  it('accepts full and abbreviated lowercase hex object ids', () => {
    expect(isGitObjectId('a'.repeat(40))).toBe(true);
    expect(isGitObjectId('0123456')).toBe(true);
    expect(isGitObjectId('deadbeefcafe0123456789abcdef0123456789ab')).toBe(true);
  });

  it('rejects values git would read as an option', () => {
    expect(isGitObjectId('--output=C:/tmp/pwn.html')).toBe(false);
    expect(isGitObjectId('-deadbeef')).toBe(false);
    expect(isGitObjectId('--end-of-options')).toBe(false);
  });

  it('rejects non-object-id shapes (symbolic refs, ranges, paths, too short/long)', () => {
    expect(isGitObjectId('HEAD')).toBe(false);
    expect(isGitObjectId('HEAD~1')).toBe(false);
    expect(isGitObjectId('deadbee..cafebab')).toBe(false);
    expect(isGitObjectId('deadbeef:templates/x.html')).toBe(false);
    expect(isGitObjectId('')).toBe(false);
    expect(isGitObjectId('abcdef')).toBe(false);
    expect(isGitObjectId('a'.repeat(41))).toBe(false);
  });

  it('rejects uppercase hex and values padded with whitespace or newlines', () => {
    // git のログ由来 hash は常に小文字。大文字を許すと検査の同値類が増えるだけで実益がない。
    expect(isGitObjectId('ABCDEF0')).toBe(false);
    expect(isGitObjectId(' deadbeef')).toBe(false);
    // JS の `$` は末尾改行の手前では一致しないが、退行しやすい前提なので固定する。
    expect(isGitObjectId('deadbeef\n--output=x')).toBe(false);
    expect(isGitObjectId('deadbeef\n')).toBe(false);
  });
});
