import { describe, expect, it } from 'vitest';
import {
  assertTemplateAttributeToken,
  assertTemplateFileName,
  isValidFundCode,
  isValidTemplateId,
  isValidTemplateToken,
  parseTemplateFileName,
  TEMPLATE_FILENAME_RE,
  type TemplateAttributes,
  templateFileName,
  templateIdFromFileName,
} from '../src/index';

const SAMPLE: TemplateAttributes = {
  companyCode: 'AM01',
  fundCode: '510037',
  baseDate: '20240710',
  editionType: 'kr',
};
const SAMPLE_FILE = 'AM01_510037_20240710_kr.html';

describe('parseTemplateFileName', () => {
  it('parses the four attributes from a valid filename', () => {
    expect(parseTemplateFileName(SAMPLE_FILE)).toEqual(SAMPLE);
  });

  it('returns null for a name with the wrong number of segments', () => {
    expect(parseTemplateFileName('AM01_510037_20240710.html')).toBeNull();
  });

  it('returns null when the .html extension is missing', () => {
    expect(parseTemplateFileName('AM01_510037_20240710_kr.txt')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseTemplateFileName('')).toBeNull();
  });
});

describe('templateFileName', () => {
  it('joins attributes into the filename convention', () => {
    expect(templateFileName(SAMPLE)).toBe(SAMPLE_FILE);
  });
});

describe('templateIdFromFileName', () => {
  it('strips the .html extension', () => {
    expect(templateIdFromFileName(SAMPLE_FILE)).toBe('AM01_510037_20240710_kr');
  });

  it('leaves a name without extension unchanged', () => {
    expect(templateIdFromFileName('AM01_510037_20240710_kr')).toBe('AM01_510037_20240710_kr');
  });
});

describe('round-trip', () => {
  it('parse -> templateFileName reproduces the original filename', () => {
    const attrs = parseTemplateFileName(SAMPLE_FILE);
    expect(attrs).toEqual(SAMPLE);
    if (attrs) expect(templateFileName(attrs)).toBe(SAMPLE_FILE);
  });

  it('attributes -> filename -> id is stable', () => {
    const file = templateFileName(SAMPLE);
    expect(templateIdFromFileName(file)).toBe('AM01_510037_20240710_kr');
  });
});

describe('TEMPLATE_FILENAME_RE', () => {
  it('matches a valid filename and rejects an invalid one', () => {
    expect(TEMPLATE_FILENAME_RE.test(SAMPLE_FILE)).toBe(true);
    expect(TEMPLATE_FILENAME_RE.test('not-a-template.html')).toBe(false);
  });
});

// ── セグメント検査はトークンごとに掛ける ──
// 検査を**組み立て済みファイル名**にだけ掛けると `AM01 _510037_20240710_交付版.html`
// が通る。トークン内部の末尾空白はファイル名全体の trim では消えないのに、SQL Server の
// `=` は末尾空白を無視するので、2 つのファイルが同じ台帳行へ対応する状態を作れる。
describe('トークン単位のパス安全性ゲート', () => {
  const EVIL_TOKENS = [
    'AM01 ', // 末尾空白(SQL Server の `=` が無視する)
    ' AM01', // 先頭空白
    'AM01.', // 末尾ドット(Windows が黙って落とす)
    'AM01/x',
    'AM01\\x',
    '..',
    'AM01:x',
    'AM01*',
    '',
  ];

  it.each(EVIL_TOKENS)('トークン %j は不正と判定する', (token) => {
    expect(isValidTemplateToken(token)).toBe(false);
    expect(() => assertTemplateAttributeToken('会社コード', token)).toThrow();
  });

  it.each(
    EVIL_TOKENS.filter((t) => !/[/\\]/.test(t) && t !== ''),
  )('トークン %j を含むファイル名は assertTemplateFileName が拒否する', (token) => {
    expect(() => assertTemplateFileName(`${token}_510037_20240710_交付版.html`)).toThrow();
    expect(isValidTemplateId(`${token}_510037_20240710_交付版`)).toBe(false);
  });

  it('版種トークンの末尾空白も拒否する(4 トークン全部を見る)', () => {
    expect(() => assertTemplateFileName('AM01_510037_20240710_交付版 .html')).toThrow();
    expect(isValidTemplateId('AM01_510037_20240710_交付版 ')).toBe(false);
  });

  it('正当なファイル名・id は従来どおり通る(業務を止めない)', () => {
    expect(assertTemplateFileName('AM01_510037_20240710_交付版.html')).toBe(
      'AM01_510037_20240710_交付版.html',
    );
    expect(isValidTemplateId('AM01_510037_20240710_交付版')).toBe(true);
    expect(isValidFundCode('510037')).toBe(true);
  });

  it('fundCode の判定はトークン判定と同一(片方だけ緩まない)', () => {
    for (const token of EVIL_TOKENS) {
      expect(isValidFundCode(token), token).toBe(isValidTemplateToken(token));
    }
    expect(isValidFundCode('510_037')).toBe(false);
  });
});
