import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generatorLogPath,
  logSizeBefore,
  OUTPUT_MARKER,
  parseOutputNames,
  readRunLog,
} from '../src/generate/generatorLog.js';

let dir: string;
let n = 0;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genlog-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const newLog = (): string => path.join(dir, `run${n++}.log`);

describe('generatorLogPath', () => {
  it('スクリプトの隣の log フォルダに 会社_ファンド_基準日 で組む', () => {
    expect(generatorLogPath('/r/template/src/build.py', 'R-AM01', '510037', '2026-10-23')).toBe(
      path.resolve('/r/template/log/build_R-AM01_510037_2026-10-23.log'),
    );
  });
});

describe('logSizeBefore', () => {
  it('ログが無ければ起動前の長さは 0', async () => {
    expect(await logSizeBefore(newLog())).toBe(0);
  });
  it('あれば長さを返す', async () => {
    const f = newLog();
    fs.writeFileSync(f, 'abc');
    expect(await logSizeBefore(f)).toBe(3);
  });
  it('通常のファイルでなければ投げる', async () => {
    await expect(logSizeBefore(dir)).rejects.toThrow('実行ログ');
  });
});

describe('readRunLog', () => {
  it('追記分だけを読む', async () => {
    const f = newLog();
    fs.writeFileSync(f, 'x [OUTPUT] OLD_1_交付版.html\n');
    const before = await logSizeBefore(f);
    fs.appendFileSync(f, 'y [OUTPUT] NEW_1_交付版.html\n');
    const text = await readRunLog(f, before);
    expect(text).not.toContain('OLD');
    expect(text).toContain('NEW');
  });
  it('起動前より短ければ全体を読む', async () => {
    const f = newLog();
    fs.writeFileSync(f, '12345678901234567890');
    expect(await readRunLog(f, 100)).toBe('12345678901234567890');
  });
  it('先頭から読むときは BOM を落とす', async () => {
    const f = newLog();
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]));
    expect(await readRunLog(f, 0)).toBe('hi');
  });
  it('終了後にログが無ければ失敗', async () => {
    await expect(readRunLog(newLog(), 0)).rejects.toThrow(/実行ログ.*run\d+\.log/);
  });
  it('増えていなければ失敗', async () => {
    const f = newLog();
    fs.writeFileSync(f, 'abc');
    await expect(readRunLog(f, 3)).rejects.toThrow('実行ログ');
  });
  it('上限を超える追記は失敗', async () => {
    const f = newLog();
    fs.writeFileSync(f, '');
    fs.appendFileSync(f, '12345678901');
    await expect(readRunLog(f, 0, 10)).rejects.toThrow('実行ログ');
  });
  it('UTF-8 として読めなければ失敗', async () => {
    const f = newLog();
    fs.writeFileSync(f, 'a');
    fs.appendFileSync(f, Buffer.from([0x83, 0x65]));
    await expect(readRunLog(f, 1)).rejects.toThrow('実行ログ');
  });
});

describe('parseOutputNames', () => {
  it('印の後ろをファイル名として取り、CRLF を落とす', () => {
    expect(
      parseOutputNames('2026-10-23 10:00:00 INFO [OUTPUT] AM01_510037_交付版.html\r\n'),
    ).toEqual(['AM01_510037_交付版.html']);
  });
  it('印の無い行・空行は無視', () => {
    expect(parseOutputNames('start\n\n[OUTPUT] a_b_交付版.html\nend')).toEqual(['a_b_交付版.html']);
  });
  it('重複は 1 つ(最初の位置)', () => {
    expect(parseOutputNames('[OUTPUT] A\n[OUTPUT] B\n[OUTPUT] A ')).toEqual(['A', 'B']);
  });
  it('行の中の最初の印から', () => {
    expect(parseOutputNames('x [OUTPUT] A [OUTPUT] B')).toEqual(['A [OUTPUT] B']);
  });
  it('印の後ろが空なら投げる', () => {
    expect(() => parseOutputNames('[OUTPUT]    \n')).toThrow();
  });
  it('定数は末尾に空白を持つ', () => {
    expect(OUTPUT_MARKER).toBe('[OUTPUT] ');
  });
});
