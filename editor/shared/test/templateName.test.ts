import { describe, expect, it } from 'vitest';
import {
  anyTemplateFileName,
  assertTemplateAttributeToken,
  assertTemplateFileName,
  cssFileNameOf,
  type FilledTemplateAttributes,
  isValidTemplateId,
  isValidTemplateToken,
  parseAnyTemplateFileName,
  parseSkeletonFileName,
  parseTemplateFileName,
  skeletonFileName,
  TEMPLATE_FILENAME_RE,
  templateFileName,
  templateIdFromFileName,
} from '../src/index';

const SAMPLE: FilledTemplateAttributes = {
  companyCode: 'XX01',
  fundCode: '950037',
  baseDate: '20240710',
  editionType: 'kr',
};
const SAMPLE_FILE = 'XX01_950037_20240710_kr.html';

describe('parseTemplateFileName', () => {
  it('parses the four attributes from a valid filename', () => {
    expect(parseTemplateFileName(SAMPLE_FILE)).toEqual(SAMPLE);
  });

  it('returns null for a name with the wrong number of segments', () => {
    expect(parseTemplateFileName('XX01_950037_20240710.html')).toBeNull();
  });

  it('returns null when the .html extension is missing', () => {
    expect(parseTemplateFileName('XX01_950037_20240710_kr.txt')).toBeNull();
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
    expect(templateIdFromFileName(SAMPLE_FILE)).toBe('XX01_950037_20240710_kr');
  });

  it('leaves a name without extension unchanged', () => {
    expect(templateIdFromFileName('XX01_950037_20240710_kr')).toBe('XX01_950037_20240710_kr');
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
    expect(templateIdFromFileName(file)).toBe('XX01_950037_20240710_kr');
  });
});

describe('TEMPLATE_FILENAME_RE', () => {
  it('matches a valid filename and rejects an invalid one', () => {
    expect(TEMPLATE_FILENAME_RE.test(SAMPLE_FILE)).toBe(true);
    expect(TEMPLATE_FILENAME_RE.test('not-a-template.html')).toBe(false);
  });
});

// ── セグメント検査はトークンごとに掛ける ──
// 検査を**組み立て済みファイル名**にだけ掛けると `XX01 _950037_20240710_交付版.html`
// が通る。トークン内部の末尾空白はファイル名全体の trim では消えないのに、SQL Server の
// `=` は末尾空白を無視するので、2 つのファイルが同じ台帳行へ対応する状態を作れる。
describe('トークン単位のパス安全性ゲート', () => {
  const EVIL_TOKENS = [
    'XX01 ', // 末尾空白(SQL Server の `=` が無視する)
    ' XX01', // 先頭空白
    'XX01.', // 末尾ドット(Windows が黙って落とす)
    'XX01/x',
    'XX01\\x',
    '..',
    'XX01:x',
    'XX01*',
    '',
  ];

  it.each(EVIL_TOKENS)('トークン %j は不正と判定する', (token) => {
    expect(isValidTemplateToken(token)).toBe(false);
    expect(() => assertTemplateAttributeToken('会社コード', token)).toThrow();
  });

  it.each(EVIL_TOKENS.filter((t) => !/[/\\]/.test(t) && t !== ''))(
    'トークン %j を含むファイル名は assertTemplateFileName が拒否する',
    (token) => {
      expect(() => assertTemplateFileName(`${token}_950037_20240710_交付版.html`)).toThrow();
      expect(isValidTemplateId(`${token}_950037_20240710_交付版`)).toBe(false);
    },
  );

  it('版種トークンの末尾空白も拒否する(4 トークン全部を見る)', () => {
    expect(() => assertTemplateFileName('XX01_950037_20240710_交付版 .html')).toThrow();
    expect(isValidTemplateId('XX01_950037_20240710_交付版 ')).toBe(false);
  });

  it('正当なファイル名・id は従来どおり通る(業務を止めない)', () => {
    expect(assertTemplateFileName('XX01_950037_20240710_交付版.html')).toBe(
      'XX01_950037_20240710_交付版.html',
    );
    expect(isValidTemplateId('XX01_950037_20240710_交付版')).toBe(true);
    expect(isValidTemplateToken('950037')).toBe(true);
  });

  it('トークンの区切りの `_` は不正と判定する', () => {
    expect(isValidTemplateToken('510_037')).toBe(false);
  });
});

describe('テンプレート(3 つ区切り)のファイル名', () => {
  const SKELETON = { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' };

  it('parseSkeletonFileName は 3 つ区切りだけを解析する', () => {
    expect(parseSkeletonFileName('XX01_950037_交付版.html')).toEqual(SKELETON);
    expect(parseSkeletonFileName('XX01_950037_20240710_交付版.html')).toBeNull();
    expect(parseSkeletonFileName('XX01_950037.html')).toBeNull();
  });

  it('parseTemplateFileName は 3 つ区切りを解析しない(2 つの形は重ならない)', () => {
    expect(parseTemplateFileName('XX01_950037_交付版.html')).toBeNull();
  });

  it('skeletonFileName は基準日を入れない', () => {
    expect(skeletonFileName(SKELETON)).toBe('XX01_950037_交付版.html');
  });

  it('parseAnyTemplateFileName は形に応じて基準日の有無を返す', () => {
    expect(parseAnyTemplateFileName('XX01_950037_交付版.html')).toEqual(SKELETON);
    expect(parseAnyTemplateFileName(SAMPLE_FILE)).toEqual(SAMPLE);
    expect(parseAnyTemplateFileName('XX01.html')).toBeNull();
  });

  it('anyTemplateFileName は基準日があれば 4 つ、無ければ 3 つ区切りで組む', () => {
    expect(anyTemplateFileName(SAMPLE)).toBe(SAMPLE_FILE);
    expect(anyTemplateFileName(SKELETON)).toBe('XX01_950037_交付版.html');
  });

  it('templateIdFromFileName は形を問わず .html を外す', () => {
    expect(templateIdFromFileName('XX01_950037_交付版.html')).toBe('XX01_950037_交付版');
  });
});

describe('cssFileNameOf — 文書 ID からテンプレ単位の CSS 名を導く', () => {
  it.each([
    ['XXAM_910024_2024-05-17_交付版', 'XXAM_910024_交付版.css'],
    // 基準日違いの文書は同じ CSS を共有する。
    ['XXAM_910024_2024-05-18_交付版', 'XXAM_910024_交付版.css'],
    ['XXAM_910024_交付版', 'XXAM_910024_交付版.css'],
    ['XX01_950037_20240710_全体版', 'XX01_950037_全体版.css'],
  ])('%s → %s', (id, expected) => {
    expect(cssFileNameOf(id)).toBe(expected);
  });

  it.each([
    [''],
    ['XXAM_910024'],
    ['A_1_2024-05-17_交付版_余り'],
    ['A/B_1_交付版'],
    ['A_1_交付版 '],
    ['A_1_..'],
  ])('規約外 %j は null', (id) => {
    expect(cssFileNameOf(id)).toBeNull();
  });
});
