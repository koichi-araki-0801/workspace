// =============================================================================
// confirmedWrite.guard.test.ts — 確定書込の単一化(C1)と実行コード不変性(C0)の関所
// =============================================================================
// 「確定テンプレへ書くのは `repositories/confirmedWrite.ts` だけ」は doc comment では
// 守れない(実際、以前は生成ルートとペア同期が直接書いていた)。ここでは
//   ① ソース走査で**書込プリミティブの import 元が増えていないこと**を機械検査し、
//   ② チョークポイント自身が帰属検査・実行コード照合・補償を素通りさせないことを
// 迂回入力で主張する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppError } from '@editor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/git/gitRepo.js', () => ({
  ensureRepo: async () => {},
  withGitLock: async (fn: () => Promise<unknown>) => fn(),
  commitAll: async () => {},
}));

// 監査イベントを捕まえるため logger を差し替える(`audit` の呼び出し内容が検査対象)。
const auditCalls: Record<string, unknown>[] = [];
vi.mock('../src/logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...orig,
    audit: (e: Record<string, unknown>) => {
      auditCalls.push(e);
    },
  };
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-confirmedwrite-'));
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SOURCE = 'AM01_510037_20240710_交付版';
const PAIR = 'AM01_510037_20240710_全体版';
const OTHER = 'AM01_999999_20240710_全体版';

/** `src` 配下の .ts を再帰列挙し、`src` からの相対 POSIX パスで返す。 */
function listSources(dir = SRC, base = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listSources(p, base);
    if (!e.name.endsWith('.ts')) return [];
    return [path.relative(base, p).split(path.sep).join('/')];
  });
}

describe('書込プリミティブの import 許可リスト', () => {
  it('atomicWrite を import してよいのは許可リストのファイルだけ', () => {
    // 増えても減っても落ちる。新しいファイルがディスクへ直接書き始めたことに気付くための
    // 検査であって、「危険な書き込みを列挙する」検査ではない。
    const allowed = [
      'files/draftFiles.ts',
      'files/notesFile.ts',
      'files/pendingFiles.ts',
      'files/reviewFiles.ts',
      'files/syncFiles.ts',
      'repositories/confirmedWrite.ts',
    ];
    const actual = listSources().filter((rel) =>
      /from\s+'(?:\.\.?\/)*(?:files\/)?atomic\.js'/.test(
        fs.readFileSync(path.join(SRC, rel), 'utf8'),
      ),
    );
    expect(actual.sort()).toEqual(allowed.sort());
  });

  it('templatePath / cssPath を import してよいのは confirmedWrite.ts だけ', () => {
    // この 2 つは確定ディレクトリと連結する唯一の解決子。`atomicWrite` と組み合わせられる
    // のがチョークポイント 1 ファイルだけであることが「唯一の関所」の実体である。
    const actual = listSources().filter((rel) => {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const m = /import\s*\{([^}]*)\}\s*from\s*'(?:\.\.?\/)*files\/templateFiles\.js'/.exec(text);
      if (!m) return false;
      return /\b(templatePath|cssPath)\b/.test(m[1]);
    });
    expect(actual).toEqual(['repositories/confirmedWrite.ts']);
  });

  it('templateFiles.ts は書込関数を export しない(読み取りとパス解決のみ)', async () => {
    const mod = await import('../src/files/templateFiles.js');
    for (const name of ['writeTemplateAndCss', 'writeTemplateHtml', 'restoreTemplateAndCss']) {
      expect(mod).not.toHaveProperty(name);
    }
  });
});

describe('applyConfirmedWrite — 迂回入力の拒否', () => {
  let confirmedWrite: typeof import('../src/repositories/confirmedWrite.js');
  const templatesDir = path.join(root, 'data', 'templates');
  const cssDir = path.join(root, 'data', 'css');

  beforeAll(async () => {
    confirmedWrite = await import('../src/repositories/confirmedWrite.js');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    auditCalls.length = 0;
    fs.rmSync(templatesDir, { recursive: true, force: true });
    fs.rmSync(cssDir, { recursive: true, force: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(cssDir, { recursive: true });
  });

  const seed = (id: string, html: string) =>
    fs.writeFileSync(path.join(templatesDir, `${id}.html`), html, 'utf8');
  const read = (id: string) => fs.readFileSync(path.join(templatesDir, `${id}.html`), 'utf8');

  it('ペア同期の転写先は source から再計算した値と一致しなければ書かない', async () => {
    // 呼び出し側が渡した `targetTemplateId` を信じると、そこを操作するだけで無関係な
    // 確定テンプレへ書ける。1 バイトも触れていないことまで主張する。
    seed(OTHER, '<p>他人のテンプレ</p>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        targetTemplateId: OTHER,
        sourceTemplateId: SOURCE,
        html: '<p>のっとり</p>',
        actor: 'attacker',
        appliedParts: ['p1'],
      }),
    ).rejects.toSatisfy(isAppError);
    expect(read(OTHER)).toBe('<p>他人のテンプレ</p>');
    expect(auditCalls).toEqual([]);
  });

  it('review-approve の fundCode が id と食い違えば書かない', async () => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        templateId: SOURCE,
        fundCode: '999999',
        html: '<p>x</p>',
        css: 'body{}',
        author: 'editor1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(fs.existsSync(path.join(templatesDir, `${SOURCE}.html`))).toBe(false);
    expect(fs.existsSync(path.join(cssDir, '999999.css'))).toBe(false);
  });

  it('承認経路でも実行コードの追加は拒否する(承認を通しても JS は変えられない)', async () => {
    seed(SOURCE, '<html><script>col.width=1</script><p>本文</p></html>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        templateId: SOURCE,
        fundCode: '510037',
        html: '<html><script>col.width=1</script><script>fetch("/x")</script></html>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(read(SOURCE)).toBe('<html><script>col.width=1</script><p>本文</p></html>');
  });

  it('ペア転写でも実行コードの追加は拒否する(機械転写を実行面の抜け道にしない)', async () => {
    seed(PAIR, '<html><p>ペア側</p></html>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        targetTemplateId: PAIR,
        sourceTemplateId: SOURCE,
        html: '<html><p>ペア側</p><script>fetch("/x")</script></html>',
        actor: 'approver1',
        appliedParts: ['p1'],
      }),
    ).rejects.toSatisfy(isAppError);
    expect(read(PAIR)).toBe('<html><p>ペア側</p></html>');
  });

  it('afterWrite が失敗したら本体を元のバイト列へ戻す', async () => {
    // 「転写済みなのに lastSynced が古い」状態は次回同期で偽競合を生む。片方だけ進めない。
    seed(PAIR, '<p>元の内容</p>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        targetTemplateId: PAIR,
        sourceTemplateId: SOURCE,
        html: '<p>転写後</p>',
        actor: 'approver1',
        appliedParts: ['p1'],
        afterWrite: async () => {
          throw new Error('同期状態の書込に失敗');
        },
      }),
    ).rejects.toThrow('同期状態の書込に失敗');
    expect(read(PAIR)).toBe('<p>元の内容</p>');
  });

  it('ペア転写の監査には転写先と source の両方の id が残る', async () => {
    seed(PAIR, '<p>元の内容</p>');
    await confirmedWrite.applyConfirmedWrite({
      kind: 'pair-sync',
      targetTemplateId: PAIR,
      sourceTemplateId: SOURCE,
      html: '<p>転写後</p>',
      actor: 'approver1',
      appliedParts: ['p1', 'p2'],
    });
    expect(read(PAIR)).toBe('<p>転写後</p>');
    const ev = auditCalls.at(-1) as { resource: Record<string, string> };
    expect(ev.resource.templateId).toBe(PAIR);
    expect(ev.resource.sourceTemplateId).toBe(SOURCE);
  });
});
