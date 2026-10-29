// =============================================================================
// noRealData.guard.test.ts — テストデータに実在の会社・ファンドの情報を戻さない
// =============================================================================
// fixtures とテストの会社名・ファンド名・住所・URL・コードは、一目でダミーと分かる架空の値
// (`XX01`・`9xxxxx`・「架空アセットマネジメント」など)へ置き換えた。実データを貼り直すと
// また置き換えが要るので、git 管理下の editor と docs/editor の原稿を走査して止める。
// 禁止語はこのファイル自身が引っかからないよう base64 で持ち、実行時に戻す。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

/** 部分一致で禁じる語(会社名・ファンド名・住所・URL の断片)。 */
const WORDS = [
  '5LiJ5LqV5L2P5Y+L',
  'c210YW0uanA=',
  'eHhhbS5qcA==',
  '6Iqd5YWs5ZyS',
  'MTA1LTAwMTE=',
  '44Kz44Ki5oqV6LOH5oim55Wl',
  '44Kz44Ki44Op44OD44OX',
  '6auY6YeR5Yip44K944OW44Oq44Oz',
  '77yz77yt77y0',
  'VFJVU1RfQU0=',
  'U01UIEpQWA==',
  '77yq77yw77y45pel57WM',
  'SlBY5pel57WM',
].map(decode);
/** 会社コード(英字境界・大小文字を区別しない)とファンドコード(数字境界)。 */
const COMPANY_CODES = new RegExp(
  `(?<![A-Za-z0-9])(${decode('YW0wMXxhbTAyfHNtdGFt')})(?![A-Za-z0-9])`,
  'i',
);
const FUND_CODES = new RegExp(
  `(?<!\\d)(${decode('MTEwMDI0fDUxMDAwM3w1MTAwMzd8NTEwMTI0fDUxMDE1NQ==')})(?!\\d)`,
);
const BINARY = /\.(png|jpe?g|gif|pdf|woff2?|ttf|otf|ico|zip)$/i;

// 日本語のファイル名を引用符付きで返さないよう -z で取る(core.quotepath の既定は on)。
const files = execFileSync(
  'git',
  ['ls-files', '-z', 'editor', 'docs/editor/src', 'docs/editor/*.md'],
  {
    cwd: REPO_ROOT,
  },
)
  .toString('utf8')
  .split('\0')
  .filter((f) => f && !BINARY.test(f));

describe('テストデータに実データを戻さない', () => {
  it('走査対象を実際に読めている(セルフテスト)', () => {
    expect(files.length).toBeGreaterThan(100);
    // 日本語名のファイルを読み損ねて素通りしないこと。
    expect(files).toContain('docs/editor/src/設計正典.md');
    expect(files).toContain('docs/editor/承認ワークフロー設計.md');
    expect(files.some((f) => f.startsWith('editor/fixtures/'))).toBe(true);
  });

  it('禁止語が 1 つも無い', () => {
    const hits: string[] = [];
    for (const f of files) {
      // 読めなければ黙って飛ばさず、例外で落とす。
      const lines = readFileSync(path.join(REPO_ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (
          WORDS.some((w) => line.includes(w)) ||
          COMPANY_CODES.test(line) ||
          FUND_CODES.test(line)
        )
          hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
