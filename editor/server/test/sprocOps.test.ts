// =============================================================================
// sprocOps.test.ts — `OP`(操作名の定数)が `db/sproc/*.sql` の分岐と過不足なく一致する
// =============================================================================
// `OP` の値を書き間違えると、実 DB だけで未対応の操作として落ちる。偽物(sprocFake)は
// 操作名を文字列で持つので、定数と .sql の突き合わせはここで行う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OP, SP } from '../src/db/sprocNames.js';

const SPROC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'sproc');

/** `.sql` が `@操作 = N'…'` で受け付ける操作名の集合。 */
function opsInSql(key: string): Set<string> {
  const sql = fs.readFileSync(path.join(SPROC_DIR, `${key}.sql`), 'utf8');
  return new Set([...sql.matchAll(/@操作\s*=\s*N'([^']+)'/g)].map((m) => m[1] as string));
}

describe('OP と db/sproc/*.sql', () => {
  it('OP のキーは SP のキーと同じ集合', () => {
    expect(Object.keys(OP).sort()).toEqual(Object.keys(SP).sort());
  });

  for (const key of Object.keys(OP) as (keyof typeof OP)[]) {
    it(`${key}: OP の値は ${key}.sql の操作名と過不足なく一致する`, () => {
      expect(new Set(Object.values(OP[key]))).toEqual(opsInSql(key));
    });
  }
});
