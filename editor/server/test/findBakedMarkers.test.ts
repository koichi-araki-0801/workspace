import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirsFromArgs, scanDataRoot } from '../scripts/find-baked-markers';

function seed(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-'));
  const w = (rel: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), s);
  };
  w('templates/A_1_交付版.html', '<p>{{ a }}</p>');
  w('templates/A_2_交付版.html', '<p><span data-jinja="e3sgYSB9fQ==">1</span></p>');
  w('pending/A_3_交付版.html', '<table><tr data-jinja-loop-clone></tr></table>');
  w('reviews/r1/meta.json', JSON.stringify({ origin: 'create', status: 'pending' }));
  w('reviews/r1/body.html', '<p><!--jinja-rt:x:1--></p>');
  w('reviews/r2/meta.json', JSON.stringify({ origin: 'edit', status: 'pending' }));
  w('reviews/r2/body.html', '<p data-jinja="x"></p>');
  w('filled/A_1_20240710_交付版.html', '<p><span data-jinja="e3sgYSB9fQ==">1</span></p>');
  return root;
}

describe('find-baked-markers', () => {
  it('引数が無ければ null(環境変数は読まない)', () => {
    process.env.DATA_ROOT = 'C:/should/not/be/used';
    expect(dirsFromArgs([])).toBeNull();
  });

  it('--root からフォルダを決め、個別指定で上書きできる', () => {
    const d = dirsFromArgs(['--root', 'X:/r', '--pending', 'Y:/p']);
    expect(d).toEqual({
      templates: path.join('X:/r', 'templates'),
      pending: 'Y:/p',
      reviews: path.join('X:/r', 'reviews'),
      filled: path.join('X:/r', 'filled'),
    });
  });

  it('templates / pending / filled / 未処理の申請(経路を問わない)はすべて error', async () => {
    const root = seed();
    const found = await scanDataRoot(dirsFromArgs(['--root', root]) as never);
    const brief = found.map((f) => `${f.severity}:${f.file.replaceAll('\\', '/')}:${f.marker}`);
    expect(brief).toEqual([
      'error:templates/A_2_交付版.html:attr:data-jinja',
      'error:pending/A_3_交付版.html:attr:data-jinja-loop-clone',
      'error:filled/A_1_20240710_交付版.html:attr:data-jinja',
      'error:reviews/r1/body.html:comment:jinja-rt',
      'error:reviews/r2/body.html:attr:data-jinja',
    ]);
  });

  it('処理済みの申請は見ない', async () => {
    const root = seed();
    fs.writeFileSync(
      path.join(root, 'reviews/r1/meta.json'),
      JSON.stringify({ origin: 'create', status: 'approved' }),
    );
    const found = await scanDataRoot(dirsFromArgs(['--root', root]) as never);
    expect(found.some((f) => f.file.includes('r1'))).toBe(false);
  });

  it('フォルダが無くても落ちない', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-empty-'));
    expect(await scanDataRoot(dirsFromArgs(['--root', root]) as never)).toEqual([]);
  });
});
