import { describe, expect, it } from 'vitest';

import { isGarbledDriverText, sqlErrorHint } from '../src/input/sqlErrorHint.js';

describe('sqlErrorHint', () => {
  it('よく出る SQLSTATE に日本語の説明を返す', () => {
    expect(sqlErrorHint('08001')).toMatch(/サーバに接続できません/);
    expect(sqlErrorHint('08S01')).toMatch(/通信が切れました/);
    expect(sqlErrorHint('28000')).toMatch(/ログインに失敗しました/);
    expect(sqlErrorHint('IM002')).toMatch(/ODBC ドライバが見つかりません/);
    expect(sqlErrorHint('HYT00')).toMatch(/時間内に終わりませんでした/);
  });

  it('エラー番号の説明を SQLSTATE の説明より優先する', () => {
    expect(sqlErrorHint('42000', 2812)).toMatch(/ストアドが見つかりません/);
    expect(sqlErrorHint('42000', 8145)).toMatch(/パラメータ/);
    expect(sqlErrorHint('42000', 201)).toMatch(/パラメータ/);
    expect(sqlErrorHint('42000', 229)).toMatch(/権限がありません/);
    expect(sqlErrorHint('42000', 4060)).toMatch(/データベースを開けません/);
    expect(sqlErrorHint('28000', 18456)).toMatch(/ログインに失敗しました/);
  });

  it('50000 以上はストアドが自分で投げたエラー', () => {
    expect(sqlErrorHint('42000', 50000)).toMatch(/ストアドがエラーを返しました/);
    expect(sqlErrorHint('S0001', 51234)).toMatch(/ストアドがエラーを返しました/);
  });

  it('知らない組み合わせは undefined', () => {
    expect(sqlErrorHint('42000')).toBeUndefined();
    expect(sqlErrorHint('', 0)).toBeUndefined();
    expect(sqlErrorHint(undefined, 12345)).toBeUndefined();
  });
});

describe('isGarbledDriverText', () => {
  it('印字できる ASCII だけなら化けていない', () => {
    expect(
      isGarbledDriverText("[Microsoft][ODBC Driver 17 for SQL Server]Login failed for user 'x'."),
    ).toBe(false);
  });

  it('ASCII 以外を含めば化けているとみなす(ドライバは日本語の上位バイトを捨てる)', () => {
    expect(isGarbledDriverText('[Microsoft][ODBC Driver 17 for SQL Server]SQL Server xn�')).toBe(
      true,
    );
    expect(isGarbledDriverText('abc\u0001')).toBe(true);
    expect(isGarbledDriverText('ストアド')).toBe(true);
  });
});
