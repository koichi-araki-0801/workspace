// =============================================================================
// confirmedWrite.guard.test.ts — 確定書込の単一化と実行コード不変性の関所
// =============================================================================
// 「確定テンプレへ書くのは `repositories/confirmedWrite.ts` だけ」は doc comment では
// 守れない(生成ルートやペア同期からの直接書込は形の上では書けてしまう)。ここでは
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
const SOURCE = 'AM01_510037_交付版';
const PAIR = 'AM01_510037_全体版';
const OTHER = 'AM01_999999_全体版';

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
      'files/idPairStore.ts',
      'files/notesFile.ts',
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

  it('createIdPairStore を import してよいのは draftFiles.ts と pendingFiles.ts だけ', () => {
    // 任意のディレクトリへ書ける汎用の書き込み口。templates/・filled/ を渡す利用者が現れると
    // 承認ゲートを通らずに確定ファイルを書けるので、利用者を固定する。
    const actual = listSources().filter((rel) =>
      /from\s+'(?:\.\.?\/)*(?:files\/)?idPairStore\.js'/.test(
        fs.readFileSync(path.join(SRC, rel), 'utf8'),
      ),
    );
    expect(actual.sort()).toEqual(['files/draftFiles.ts', 'files/pendingFiles.ts']);
  });

  it('templatePath / resolveTemplateCssPath / filledPath を import してよいのは confirmedWrite.ts だけ', () => {
    // この 3 つは確定ディレクトリと連結する唯一の解決子。`atomicWrite` と組み合わせられる
    // のがチョークポイント 1 ファイルだけであることが「唯一の関所」の実体である。
    const actual = listSources().filter((rel) => {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const m = /import\s*\{([^}]*)\}\s*from\s*'(?:\.\.?\/)*files\/templateFiles\.js'/.exec(text);
      if (!m) return false;
      return /\b(templatePath|resolveTemplateCssPath|filledPath)\b/.test(m[1]);
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
  const filledDir = path.join(root, 'data', 'filled');

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
        target: 'template',
        targetTemplateId: OTHER,
        sourceTemplateId: SOURCE,
        html: '<p>のっとり</p>',
        css: '.pwned{}',
        actor: 'attacker',
        appliedParts: ['p1'],
      }),
    ).rejects.toSatisfy(isAppError);
    expect(read(OTHER)).toBe('<p>他人のテンプレ</p>');
    expect(auditCalls).toEqual([]);
    expect(fs.existsSync(path.join(cssDir, 'AM01_999999_全体版.css'))).toBe(false);
  });

  it('review-approve の CSS は id から決まり、同じファンドの別の版種や別のファンドの CSS に触れない', async () => {
    fs.writeFileSync(path.join(cssDir, 'AM01_510037_全体版.css'), '.zentai{}', 'utf8');
    fs.writeFileSync(path.join(cssDir, 'AM01_999999_交付版.css'), '.other{}', 'utf8');
    await confirmedWrite.applyConfirmedWrite({
      kind: 'review-approve',
      target: 'filled',
      templateId: 'AM01_510037_20240710_交付版',
      html: '<p>x</p>',
      css: '.kofu{}',
      author: 'approver1',
      commitMessage: 'm',
    });
    expect(fs.readFileSync(path.join(cssDir, 'AM01_510037_交付版.css'), 'utf8')).toBe('.kofu{}');
    expect(fs.readFileSync(path.join(cssDir, 'AM01_510037_全体版.css'), 'utf8')).toBe('.zentai{}');
    expect(fs.readFileSync(path.join(cssDir, 'AM01_999999_交付版.css'), 'utf8')).toBe('.other{}');
    expect(fs.readdirSync(cssDir).sort()).toEqual(
      ['AM01_510037_交付版.css', 'AM01_510037_全体版.css', 'AM01_999999_交付版.css'].sort(),
    );
  });

  it('既存の CSS の綴り(am01_…)があればその綴りで書き、別名を増やさない', async () => {
    fs.writeFileSync(path.join(cssDir, 'am01_510037_交付版.css'), '.old{}', 'utf8');
    await confirmedWrite.applyConfirmedWrite({
      kind: 'review-approve',
      target: 'template',
      templateId: 'AM01_510037_交付版',
      html: '<p>x</p>',
      css: '.new{}',
      author: 'approver1',
      commitMessage: 'm',
    });
    expect(fs.readdirSync(cssDir)).toEqual(['am01_510037_交付版.css']);
    expect(fs.readFileSync(path.join(cssDir, 'am01_510037_交付版.css'), 'utf8')).toBe('.new{}');
  });

  it('承認経路でも実行コードの追加は拒否する(承認を通しても JS は変えられない)', async () => {
    seed(SOURCE, '<html><script>col.width=1</script><p>本文</p></html>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'template',
        templateId: SOURCE,
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
        target: 'template',
        targetTemplateId: PAIR,
        sourceTemplateId: SOURCE,
        html: '<html><p>ペア側</p><script>fetch("/x")</script></html>',
        actor: 'approver1',
        appliedParts: ['p1'],
      }),
    ).rejects.toSatisfy(isAppError);
    expect(read(PAIR)).toBe('<html><p>ペア側</p></html>');
  });

  it('テンプレートへの確定でも、往復用の印が残った本文は書かない', async () => {
    seed(SOURCE, '<p>{{ fund.name }}</p>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'template',
        templateId: SOURCE,
        html: '<p><!--jinja-rt:t:e3sgc2V0IGEgPSAxICV9-->{{ fund.name }}</p>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(read(SOURCE)).toBe('<p>{{ fund.name }}</p>');
    expect(fs.existsSync(path.join(cssDir, `${SOURCE}.css`))).toBe(false);
  });

  it('値入り HTML への確定でも、往復用の印が残った本文は書かない', async () => {
    const id = 'AM01_510037_20250101_交付版';
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'filled',
        templateId: id,
        html: '<table><tbody><tr data-jinja-loop-clone=""><td>1</td></tr></tbody></table>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fs.existsSync(path.join(filledDir, `${id}.html`))).toBe(false);
    expect(fs.existsSync(path.join(cssDir, 'AM01_510037_交付版.css'))).toBe(false);
  });

  it('ペア転写でも、往復用の印が残った本文は書かない', async () => {
    seed(PAIR, '<p>ペア側</p>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        target: 'template',
        targetTemplateId: PAIR,
        sourceTemplateId: SOURCE,
        html: '<p><span data-jinja="e3sgYSB9fQ==">1</span></p>',
        actor: 'approver1',
        appliedParts: ['p1'],
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(read(PAIR)).toBe('<p>ペア側</p>');
  });

  it('afterWrite が失敗したら本体を元のバイト列へ戻す', async () => {
    // 「転写済みなのに lastSynced が古い」状態は次回同期で偽競合を生む。片方だけ進めない。
    seed(PAIR, '<p>元の内容</p>');
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        target: 'template',
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
      target: 'template',
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

  it('値入り HTML(target=filled)にテンプレートの id(3 つ区切り)は書けない', async () => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'filled',
        templateId: 'AM01_510037_交付版',
        html: '<p>x</p>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(fs.existsSync(path.join(filledDir, 'AM01_510037_交付版.html'))).toBe(false);
    expect(fs.existsSync(path.join(cssDir, 'AM01_510037_交付版.css'))).toBe(false);
  });

  it('テンプレート(target=template)に値入り HTML の id(4 つ区切り)は書けない', async () => {
    await expect(
      confirmedWrite.applyConfirmedWrite({
        kind: 'review-approve',
        target: 'template',
        templateId: 'AM01_510037_20240710_交付版',
        html: '<p>x</p>',
        css: '',
        author: 'approver1',
        commitMessage: 'm',
      }),
    ).rejects.toSatisfy(isAppError);
    expect(fs.readdirSync(templatesDir)).toEqual([]);
  });

  const cssFile = (name: string) => path.join(cssDir, name);

  it('ペア転写の CSS は転写先 id から決まる CSS にだけ書く', async () => {
    seed(PAIR, '<p>ペア側</p>');
    fs.writeFileSync(cssFile('AM01_510037_全体版.css'), '.old{}', 'utf8');
    fs.writeFileSync(cssFile('AM01_510037_交付版.css'), '.source{}', 'utf8');
    await confirmedWrite.applyConfirmedWrite({
      kind: 'pair-sync',
      target: 'template',
      targetTemplateId: PAIR,
      sourceTemplateId: SOURCE,
      html: '<p>ペア側</p>',
      css: '.new{}',
      actor: 'approver1',
      appliedParts: [],
      appliedCssRules: ['.new'],
    });
    expect(fs.readFileSync(cssFile('AM01_510037_全体版.css'), 'utf8')).toBe('.new{}');
    expect(fs.readFileSync(cssFile('AM01_510037_交付版.css'), 'utf8')).toBe('.source{}');
    const ev = auditCalls.at(-1) as { detail: Record<string, number> };
    expect(ev.detail.appliedCssRules).toBe(1);
  });

  it('css を渡さないペア転写は CSS に触れない', async () => {
    seed(PAIR, '<p>元</p>');
    fs.writeFileSync(cssFile('AM01_510037_全体版.css'), '.keep{}', 'utf8');
    await confirmedWrite.applyConfirmedWrite({
      kind: 'pair-sync',
      target: 'template',
      targetTemplateId: PAIR,
      sourceTemplateId: SOURCE,
      html: '<p>転写後</p>',
      actor: 'approver1',
      appliedParts: ['p1'],
    });
    expect(fs.readFileSync(cssFile('AM01_510037_全体版.css'), 'utf8')).toBe('.keep{}');
  });

  it('afterWrite が失敗したらペアの CSS も元へ戻す(無かった CSS は消す)', async () => {
    seed(PAIR, '<p>元</p>');
    fs.writeFileSync(cssFile('AM01_510037_全体版.css'), '.old{}', 'utf8');
    const fail = () =>
      confirmedWrite.applyConfirmedWrite({
        kind: 'pair-sync',
        target: 'template',
        targetTemplateId: PAIR,
        sourceTemplateId: SOURCE,
        html: '<p>転写後</p>',
        css: '.new{}',
        actor: 'approver1',
        appliedParts: ['p1'],
        afterWrite: async () => {
          throw new Error('同期状態の書込に失敗');
        },
      });
    await expect(fail()).rejects.toThrow('同期状態の書込に失敗');
    expect(fs.readFileSync(cssFile('AM01_510037_全体版.css'), 'utf8')).toBe('.old{}');
    fs.rmSync(cssFile('AM01_510037_全体版.css'));
    await expect(fail()).rejects.toThrow('同期状態の書込に失敗');
    expect(fs.existsSync(cssFile('AM01_510037_全体版.css'))).toBe(false);
  });
});
