// =============================================================================
// guardCoverage.guard.test.ts — 「守りの射程」を数え落とす型の再発を止める
// =============================================================================
// 再スキャンで見つかった迂回は、個別の穴というより**同じ 1 つの型**だった:
// 新しい守りを入れたとき、旧い脅威を覆っていた範囲と新しい守りの射程の差分を数えなかった。
//
// 個別の穴はそれぞれの場所で塞いだが、教訓が事例のままだと同じ型がまた生える。そこで
// 「このガードが覆う入口はこれで全部」という**列挙そのもの**を機械検証する。列挙の外に
// 入口が増えたらここが落ちる。
//
// 本ファイルはソースの字面を読む。実行時の振る舞いは各機能のテストが持っており、こちらの
// 役割は「守りを足す場所を書き漏らしていないか」だけを見ることにある。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.join(HERE, '..', 'src');
const REPO = path.join(HERE, '..', '..', '..');

/** 拡張子で絞ってソースを再帰列挙する(生成物は見ない)。 */
function sourceFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full, exts));
      continue;
    }
    if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const read = (p: string): string => fs.readFileSync(p, 'utf8');

describe('raw text 要素は「読み飛ばした範囲を検査する」が対で在る', () => {
  // 走査器が raw text として読み飛ばす要素は、その中身を必ず何かの形で検査すること。
  // 見落とすと、その内側が検査から**完全に消える**。`templateScripts` では `style` が、
  // `externalRefs` では `title`/`textarea`/`noscript` がこの形で抜けていた。
  it('templateScripts の RAW_TEXT_ELEMENTS は collectInto に専用分岐を持つ', () => {
    const src = read(path.join(SERVER_SRC, 'security', 'templateScripts.ts'));
    const list = /const RAW_TEXT_ELEMENTS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    const names = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // `collectInto` の中に `tag.name === '<要素>'` の分岐が在ること。
      expect(src, `${name} を raw text 扱いしているのに単位化の分岐が無い`).toContain(
        `tag.name === '${name}'`,
      );
    }
  });

  it('externalRefs は raw text の中身を再走査する(script を除く)', () => {
    const src = read(path.join(SERVER_SRC, 'security', 'externalRefs.ts'));
    // 「style は CSS として」「それ以外は文書として再帰」という 2 本立てが在ること。
    expect(src).toContain("tag.name === 'style'");
    // 整形で改行が入るので、条件の各項が在ることで見る。
    expect(src).toContain('tag.rawText !== undefined');
    expect(src).toContain("tag.name !== 'script'");
    expect(src).toMatch(/collectHtmlRefs\(tag\.rawText, out, depth \+ 1\)/);
  });
});

describe('展開を許す形式は外部参照の検査を持つ', () => {
  // zip 経路は「展開してよい拡張子」と「中身を検査する拡張子」の 2 つの集合を持つ。
  // 前者にしか無い形式は検査ゲートの外側になる(`.md` / `.svg` が実際にそうだった)。
  it('参照を書ける形式が検査側の集合にも在る', () => {
    const input = read(path.join(SERVER_SRC, 'vivliostyle', 'projectInput.ts'));
    const refs = read(path.join(SERVER_SRC, 'security', 'externalRefs.ts'));
    const allowed = new Set(
      [
        ...(
          /const ALLOWED_EXTENSIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(input)?.[1] ?? ''
        ).matchAll(/'(\.[a-z.]+)'/g),
      ].map((m) => m[1]),
    );
    expect(allowed.size).toBeGreaterThan(5);
    // 画像・フォントは参照を書けない(バイナリ資産)。テキストで参照を書ける形式だけを見る。
    const canReference = [...allowed].filter((e) =>
      ['.html', '.htm', '.xhtml', '.xht', '.css', '.svg', '.md', '.markdown'].includes(e),
    );
    for (const ext of canReference) {
      expect(refs, `${ext} は展開できるのに検査側の集合に無い`).toContain(`'${ext}'`);
    }
  });
});

describe('nunjucks が外部の値へ触る経路は全部包む', () => {
  // 隔離ホストの多層防御は「プロパティ参照」「グローバル参照」「フィルタ解決」の 3 経路。
  // 当初は前 2 者しか包んでおらず、フィルタ解決だけが素通りしていた。
  it('3 経路それぞれの遮断がブートスクリプトに在る', () => {
    const src = read(path.join(SERVER_SRC, 'render', 'renderHost.ts'));
    expect(src).toContain('RT.memberLookup=');
    expect(src).toContain('RT.contextOrFrameLookup=');
    expect(src).toContain('env.globals=Object.create(null)');
    expect(src).toContain('env.filters=ownFilters');
  });
});

describe('requirements を pip へ渡す入口は全部が検査を通る', () => {
  // 検査が publish 経路にしか無かった頃、同じ requirements を渡す入口が他に 3 つあった。
  // `--no-index` は requirements 内の `--find-links <URL>` を止めないので省略できない。
  it('pip へ requirements を渡す箇所には必ず検査の呼び出しが在る', () => {
    const scripts = [
      ...sourceFiles(path.join(REPO, 'offline'), ['.ps1']),
      ...sourceFiles(path.join(REPO, 'scripts'), ['.ps1', '.bat']),
      ...sourceFiles(path.join(REPO, 'docs', '_build'), ['.bat', '.ps1']),
      ...sourceFiles(path.join(REPO, 'editor', 'scripts'), ['.ps1', '.bat']),
    ];
    const callers = scripts.filter((f) => /-r\s+["'$]?[^\s]*[Rr]equirements/.test(read(f)));
    expect(callers.length).toBeGreaterThan(0);
    for (const f of callers) {
      const src = read(f);
      const guarded =
        src.includes('Assert-OfflineRequirementsFile') ||
        src.includes('Test-OfflineRequirementsFile') ||
        src.includes('check-requirements');
      expect(guarded, `${path.relative(REPO, f)} が検査を通らずに pip へ渡している`).toBe(true);
    }
  });
});
