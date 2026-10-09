import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { imagesDirFromArgs, scanImages } from '../scripts/find-svg-violations';

const OK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
const NAMED =
  '<svg xmlns="http://www.w3.org/2000/svg" name="qr"><rect width="1" height="1"/></svg>';
const BAD_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const BAD_ATTR = '<svg xmlns="http://www.w3.org/2000/svg" zzz-unknown="1"><rect/></svg>';

function seed(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svgviol-'));
  const w = (rel: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), s);
  };
  w('images/top_bad.svg', BAD_ATTR);
  w('images/AM01/bad.svg', BAD_SCRIPT);
  w('images/AM01/UPPER.SVG', BAD_SCRIPT);
  w('images/AM01/ok.svg', OK);
  w('images/AM01/qr.svg', NAMED);
  w('images/AM01/deep/too_deep.svg', BAD_SCRIPT);
  w('images/AM01/raster.png', BAD_SCRIPT);
  return root;
}

describe('find-svg-violations', () => {
  it('引数が無ければ null(環境変数は読まない)', () => {
    process.env.DATA_ROOT = 'C:/should/not/be/used';
    expect(imagesDirFromArgs([])).toBeNull();
  });

  it('--root から images を決め、--images で上書きできる', () => {
    expect(imagesDirFromArgs(['--root', 'X:/r'])).toBe(path.join('X:/r', 'images'));
    expect(imagesDirFromArgs(['--root', 'X:/r', '--images', 'Y:/i'])).toBe('Y:/i');
  });

  it('直下と 1 段下の .svg / .SVG だけを見て、違反だけを返す', async () => {
    const root = seed();
    const found = await scanImages(path.join(root, 'images'));
    const files = found.map((f) => f.file.replaceAll(path.sep, '/'));
    expect(files).toEqual(['images/AM01/UPPER.SVG', 'images/AM01/bad.svg', 'images/top_bad.svg']);
    expect(found.every((f) => f.violation.length > 0)).toBe(true);
  });

  it('読み取り専用(中身も更新時刻も変わらない)', async () => {
    const root = seed();
    const target = path.join(root, 'images/AM01/bad.svg');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(target, past, past);
    const before = fs.readFileSync(target, 'utf8');
    await scanImages(path.join(root, 'images'));
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.statSync(target).mtimeMs).toBe(past.getTime());
    expect(fs.readdirSync(path.join(root, 'images/AM01')).length).toBe(6);
  });

  it('フォルダが無くても落ちない', async () => {
    expect(await scanImages(path.join(os.tmpdir(), 'no-such-images-dir-xyz'))).toEqual([]);
  });
});
