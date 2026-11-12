// =============================================================================
// gitRepoInitScriptSync.test.ts — init-data-repo.ps1 と gitRepo.ts の設定行の一致検査
// =============================================================================
// 同じ .gitignore / .gitattributes の規則を TS と PowerShell で別々に持つので、行の
// 並びが食い違っていないことをここで固定する(片方だけ直す drift を防ぐ)。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GITATTRIBUTES_REQUIRED,
  GITIGNORE_REMOVED,
  GITIGNORE_REQUIRED,
} from '../src/git/gitRepo.js';

const script = fs.readFileSync(path.resolve(__dirname, '../../scripts/init-data-repo.ps1'), 'utf8');

/** `$name = 'a', 'b'` の 1 行代入から、引用符で囲んだ値を順に取り出す。 */
function psList(name: string): string[] {
  const m = new RegExp(`^\\s*\\$${name} = (.+)$`, 'm').exec(script);
  if (!m) {
    throw new Error(`${name} の代入が見つからない`);
  }
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

describe('init-data-repo.ps1 と gitRepo.ts の一致', () => {
  it('.gitignore の必須行', () => {
    expect(psList('required')).toEqual([...GITIGNORE_REQUIRED]);
  });

  it('.gitignore から落とす行', () => {
    expect(psList('removed')).toEqual([...GITIGNORE_REMOVED]);
  });

  it('.gitattributes の必須行', () => {
    expect(psList('attrRequired')).toEqual([...GITATTRIBUTES_REQUIRED]);
  });
});
