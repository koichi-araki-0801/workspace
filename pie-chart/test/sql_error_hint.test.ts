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

  it('ASCII 以外を含めば、正しく読めた日本語も含めて化けているとみなす', () => {
    expect(isGarbledDriverText('[Microsoft][ODBC Driver 17 for SQL Server]SQL Server xn�')).toBe(
      true,
    );
    expect(isGarbledDriverText('abc\u0001')).toBe(true);
    expect(isGarbledDriverText('ストアド')).toBe(true);
  });

  it('? が 4 つ以上続けば化けているとみなす(6.0.0 の接続失敗の実測の形)', () => {
    expect(
      isGarbledDriverText(
        '[Microsoft][ODBC Driver 17 for SQL Server]??????????????: SQL Server ????????????? [53]. ',
      ),
    ).toBe(true);
    // 実測で最も短い連続(日本語 4 文字の語が化けたもの)。
    expect(isGarbledDriverText('[Microsoft][ODBC Driver 17 for SQL Server]???? ok')).toBe(true);
    expect(isGarbledDriverText("Is it 'x'? yes")).toBe(false);
  });

  it('英文の原文に入りうる 3 つまでの ? は化けとみなさない', () => {
    expect(isGarbledDriverText("Incorrect syntax near '??'.")).toBe(false);
    expect(isGarbledDriverText("Incorrect syntax near '???'.")).toBe(false);
  });
});

describe('sqlErrorHint(6.0.0 で増えた SQLSTATE)', () => {
  it('HY008(timeoutMs による取り消し)に説明を返す', () => {
    expect(sqlErrorHint('HY008')).toMatch(/取り消しました/);
  });
});
